import { AgoraProver } from "./prover.js";
import type { SpendReceipt, LoyaltyProofResult, MerchantEdDSAKey } from "./types.js";

/**
 * ProofCache pre-generates and caches ZK spend proofs so they're
 * available instantly at payment time. Proofs are regenerated when
 * receipts change (new purchase) or on-demand for different thresholds.
 *
 * Usage:
 *   const cache = new ProofCache(prover, buyerSecret);
 *   cache.addReceipts("merchant", scopeCommitment, receipts);
 *   // ...later, at checkout:
 *   const proof = await cache.getProof("merchant", scopeCommitment, 500_000_000n);
 *   // Returns cached proof if available, generates fresh if not
 */

interface CacheKey {
  scopeId: string;
  threshold: bigint;
  minTimestamp: bigint;
}

interface CacheEntry {
  proof: LoyaltyProofResult;
  receiptHash: string; // hash of receipt set — invalidated when receipts change
  generatedAt: number;
}

function cacheKeyStr(k: CacheKey): string {
  return `${k.scopeId}:${k.threshold}:${k.minTimestamp}`;
}

function receiptSetHash(receipts: SpendReceipt[]): string {
  return receipts
    .map(r => `${r.scopeCommitment}:${r.amount}:${r.salt}:${r.timestamp}`)
    .sort()
    .join("|");
}

export class ProofCache {
  private prover: AgoraProver;
  private buyerSecret: bigint;
  private receipts: Map<string, SpendReceipt[]> = new Map(); // scopeId → receipts
  private cache: Map<string, CacheEntry> = new Map();
  private pending: Map<string, Promise<LoyaltyProofResult>> = new Map(); // dedup in-flight

  constructor(prover: AgoraProver, buyerSecret: bigint) {
    this.prover = prover;
    this.buyerSecret = buyerSecret;
  }

  /** Store receipts for a scope. Invalidates cached and in-flight proofs for that scope. */
  addReceipts(scopeId: string, newReceipts: SpendReceipt[]) {
    const existing = this.receipts.get(scopeId) ?? [];
    this.receipts.set(scopeId, [...existing, ...newReceipts]);

    // Invalidate cached and in-flight proofs for this scope
    const prefix = scopeId + ":";
    const keysToDelete: string[] = [];
    for (const [key] of this.cache) {
      if (key.startsWith(prefix)) keysToDelete.push(key);
    }
    for (const key of keysToDelete) this.cache.delete(key);
    for (const [key] of this.pending) {
      if (key.startsWith(prefix)) this.pending.delete(key);
    }
  }

  /** Get all stored receipts for a scope. */
  getReceipts(scopeId: string): SpendReceipt[] {
    return this.receipts.get(scopeId) ?? [];
  }

  /**
   * Get a proof, returning cached if valid or generating fresh.
   * At payment time this is typically instant (cache hit).
   */
  async getProof(
    scopeId: string,
    scopeCommitment: bigint,
    threshold: bigint,
    merchantKey: MerchantEdDSAKey,
    minTimestamp: bigint = 0n,
  ): Promise<LoyaltyProofResult> {
    const key: CacheKey = { scopeId, threshold, minTimestamp };
    const keyStr = cacheKeyStr(key);

    const scopeReceipts = this.getReceipts(scopeId);
    if (scopeReceipts.length === 0) {
      throw new Error(`No receipts for scope ${scopeId}`);
    }

    // Filter by time window if needed
    const eligible = minTimestamp > 0n
      ? scopeReceipts.filter(r => r.timestamp >= minTimestamp)
      : scopeReceipts;

    const currentHash = receiptSetHash(eligible);

    // Check cache
    const cached = this.cache.get(keyStr);
    if (cached && cached.receiptHash === currentHash) {
      return cached.proof;
    }

    // Dedup: if already generating for this key, wait for it
    const inflight = this.pending.get(keyStr);
    if (inflight) return inflight;

    // Generate fresh proof
    const promise = this.prover.proveSpend({
      receipts: eligible,
      buyerSecret: this.buyerSecret,
      scopeCommitment,
      threshold,
      minTimestamp,
      merchantKey,
    }).then(proof => {
      this.cache.set(keyStr, {
        proof,
        receiptHash: currentHash,
        generatedAt: Date.now(),
      });
      this.pending.delete(keyStr);
      return proof;
    }).catch(err => {
      this.pending.delete(keyStr);
      throw err;
    });

    this.pending.set(keyStr, promise);
    return promise;
  }

  /**
   * Pre-warm the cache for common thresholds.
   * Call this after adding receipts — runs proof generation in background.
   * Returns immediately; proofs are ready when getProof is called later.
   */
  preWarm(
    scopeId: string,
    scopeCommitment: bigint,
    thresholds: bigint[],
    merchantKey: MerchantEdDSAKey,
    minTimestamp: bigint = 0n,
  ): void {
    for (const threshold of thresholds) {
      this.getProof(scopeId, scopeCommitment, threshold, merchantKey, minTimestamp).catch(() => {});
    }
  }

  /** Check if a proof is cached and valid for the current receipt set. */
  hasCachedProof(
    scopeId: string,
    threshold: bigint,
    minTimestamp: bigint = 0n,
  ): boolean {
    const keyStr = cacheKeyStr({ scopeId, threshold, minTimestamp });
    const cached = this.cache.get(keyStr);
    if (!cached) return false;

    const scopeReceipts = this.getReceipts(scopeId);
    const eligible = minTimestamp > 0n
      ? scopeReceipts.filter(r => r.timestamp >= minTimestamp)
      : scopeReceipts;

    return cached.receiptHash === receiptSetHash(eligible);
  }

  /** Clear all cached proofs. */
  clear() {
    this.cache.clear();
    this.pending.clear();
  }

  /** Get cache stats for diagnostics. */
  stats(): { cached: number; pending: number; scopes: number } {
    return {
      cached: this.cache.size,
      pending: this.pending.size,
      scopes: this.receipts.size,
    };
  }
}
