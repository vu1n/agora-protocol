import { describe, test, expect, beforeEach } from "bun:test";
import { ProofCache } from "../proof-cache.js";
import type { AgoraProver } from "../prover.js";
import type { SpendReceipt, LoyaltyProofResult, Groth16Proof } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let proveCallCount = 0;

function makeFakeProof(id: number): LoyaltyProofResult {
  return {
    proof: {
      pi_a: [String(id), "2"],
      pi_b: [
        ["3", "4"],
        ["5", "6"],
      ],
      pi_c: ["7", "8"],
    } satisfies Groth16Proof,
    publicSignals: ["100", "200", "300", "400", "500", "600"],
    nullifier: BigInt(id),
  };
}

function makeMockProver(): AgoraProver {
  return {
    async proveSpend(_params: unknown): Promise<LoyaltyProofResult> {
      proveCallCount++;
      return makeFakeProof(proveCallCount);
    },
  } as unknown as AgoraProver;
}

function makeReceipt(overrides?: Partial<SpendReceipt>): SpendReceipt {
  return {
    scopeCommitment: 1000n,
    amount: 500_000_000n,
    buyerCommitment: 42n,
    salt: 99n,
    timestamp: 1700000000n,
    ...overrides,
  };
}

const SCOPE_ID = "merchant-a";
const SCOPE_COMMITMENT = 1000n;
const THRESHOLD = 500_000_000n;
const BUYER_SECRET = 12345n;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProofCache", () => {
  let cache: ProofCache;

  beforeEach(() => {
    proveCallCount = 0;
    cache = new ProofCache(makeMockProver(), BUYER_SECRET);
  });

  test("cache miss returns a fresh proof from the prover", async () => {
    cache.addReceipts(SCOPE_ID, [makeReceipt()]);

    const proof = await cache.getProof(SCOPE_ID, SCOPE_COMMITMENT, THRESHOLD);

    expect(proof).toBeDefined();
    expect(proof.proof.pi_a).toBeDefined();
    expect(proof.publicSignals).toHaveLength(6);
    expect(proveCallCount).toBe(1);
  });

  test("cache hit returns the same proof object without re-proving", async () => {
    cache.addReceipts(SCOPE_ID, [makeReceipt()]);

    const first = await cache.getProof(SCOPE_ID, SCOPE_COMMITMENT, THRESHOLD);
    const second = await cache.getProof(SCOPE_ID, SCOPE_COMMITMENT, THRESHOLD);

    // Same object reference — served from cache
    expect(second).toBe(first);
    // Prover was only called once
    expect(proveCallCount).toBe(1);
  });

  test("addReceipts invalidates cached proofs for that scope", async () => {
    cache.addReceipts(SCOPE_ID, [makeReceipt()]);

    const first = await cache.getProof(SCOPE_ID, SCOPE_COMMITMENT, THRESHOLD);
    expect(proveCallCount).toBe(1);

    // Adding new receipts should invalidate the cache
    cache.addReceipts(SCOPE_ID, [makeReceipt({ salt: 200n })]);

    const second = await cache.getProof(SCOPE_ID, SCOPE_COMMITMENT, THRESHOLD);
    // New proof was generated
    expect(proveCallCount).toBe(2);
    // Different proof object
    expect(second).not.toBe(first);
  });

  test("hasCachedProof returns false after invalidation", async () => {
    cache.addReceipts(SCOPE_ID, [makeReceipt()]);

    await cache.getProof(SCOPE_ID, SCOPE_COMMITMENT, THRESHOLD);
    expect(cache.hasCachedProof(SCOPE_ID, THRESHOLD)).toBe(true);

    // Invalidate by adding new receipts
    cache.addReceipts(SCOPE_ID, [makeReceipt({ salt: 300n })]);
    expect(cache.hasCachedProof(SCOPE_ID, THRESHOLD)).toBe(false);
  });

  test("stats() returns correct counts", async () => {
    expect(cache.stats()).toEqual({ cached: 0, pending: 0, scopes: 0 });

    cache.addReceipts(SCOPE_ID, [makeReceipt()]);
    expect(cache.stats().scopes).toBe(1);

    await cache.getProof(SCOPE_ID, SCOPE_COMMITMENT, THRESHOLD);
    expect(cache.stats()).toEqual({ cached: 1, pending: 0, scopes: 1 });

    // Add a second scope
    const scope2 = "merchant-b";
    cache.addReceipts(scope2, [makeReceipt({ scopeCommitment: 2000n })]);
    await cache.getProof(scope2, 2000n, THRESHOLD);
    expect(cache.stats()).toEqual({ cached: 2, pending: 0, scopes: 2 });
  });

  test("throws when no receipts exist for a scope", async () => {
    await expect(
      cache.getProof("nonexistent", SCOPE_COMMITMENT, THRESHOLD),
    ).rejects.toThrow("No receipts for scope nonexistent");
  });

  test("clear() removes all cached proofs", async () => {
    cache.addReceipts(SCOPE_ID, [makeReceipt()]);
    await cache.getProof(SCOPE_ID, SCOPE_COMMITMENT, THRESHOLD);

    expect(cache.stats().cached).toBe(1);
    cache.clear();
    expect(cache.stats().cached).toBe(0);
    expect(cache.stats().pending).toBe(0);
  });

  test("invalidation does not affect other scopes", async () => {
    const scope2 = "merchant-b";
    cache.addReceipts(SCOPE_ID, [makeReceipt()]);
    cache.addReceipts(scope2, [makeReceipt({ scopeCommitment: 2000n })]);

    await cache.getProof(SCOPE_ID, SCOPE_COMMITMENT, THRESHOLD);
    await cache.getProof(scope2, 2000n, THRESHOLD);
    expect(cache.stats().cached).toBe(2);

    // Invalidate only SCOPE_ID
    cache.addReceipts(SCOPE_ID, [makeReceipt({ salt: 400n })]);

    expect(cache.hasCachedProof(SCOPE_ID, THRESHOLD)).toBe(false);
    expect(cache.hasCachedProof(scope2, THRESHOLD)).toBe(true);
  });
});
