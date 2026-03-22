/**
 * Benchmark: measures tree build time and proof cache hit/miss performance.
 */
import { AgoraProver } from "./prover.js";
import { ProofCache } from "./proof-cache.js";

async function main() {
  const prover = new AgoraProver();
  await prover.init();

  const buyerSecret = 12345n;
  const buyerCommitment = prover.hash(buyerSecret);
  const scopeCommitment = prover.hash(42n);
  const now = BigInt(Math.floor(Date.now() / 1000));

  const receipts = [
    prover.createReceipt(scopeCommitment, 100_000_000n, buyerCommitment, 1001n, now - 86400n * 10n),
    prover.createReceipt(scopeCommitment, 150_000_000n, buyerCommitment, 1002n, now - 86400n * 8n),
    prover.createReceipt(scopeCommitment, 200_000_000n, buyerCommitment, 1003n, now - 86400n * 5n),
    prover.createReceipt(scopeCommitment, 75_000_000n,  buyerCommitment, 1004n, now - 86400n * 2n),
    prover.createReceipt(scopeCommitment, 50_000_000n,  buyerCommitment, 1005n, now - 86400n),
  ];

  // ── Benchmark: cold proof generation ──
  console.log("=== Cold Proof Generation ===");
  const t0 = Date.now();
  await prover.proveSpend({
    receipts,
    buyerSecret,
    scopeCommitment,
    threshold: 500_000_000n,
  });
  const coldTime = Date.now() - t0;
  console.log(`  Cold proof: ${coldTime}ms`);

  // ── Benchmark: proof cache ──
  console.log("\n=== Proof Cache ===");
  const cache = new ProofCache(prover, buyerSecret);
  cache.addReceipts("merchant_42", receipts);

  // First call: cache miss → generates proof
  const t1 = Date.now();
  await cache.getProof("merchant_42", scopeCommitment, 500_000_000n);
  const missTime = Date.now() - t1;
  console.log(`  Cache miss (generate): ${missTime}ms`);

  // Second call: cache hit → instant
  const t2 = Date.now();
  await cache.getProof("merchant_42", scopeCommitment, 500_000_000n);
  const hitTime = Date.now() - t2;
  console.log(`  Cache hit: ${hitTime}ms`);
  console.log(`  Speedup: ${(missTime / Math.max(hitTime, 0.01)).toFixed(0)}x`);

  // Pre-warm test
  console.log("\n=== Pre-warm ===");
  cache.preWarm("merchant_42", scopeCommitment, [300_000_000n, 200_000_000n]);
  // Wait for pre-warm to complete
  await new Promise(resolve => setTimeout(resolve, 100));
  const hasCached300 = cache.hasCachedProof("merchant_42", 300_000_000n);
  console.log(`  $300 threshold pre-warmed: ${hasCached300 ? "ready" : "generating..."}`);
  // Wait for actual completion
  await cache.getProof("merchant_42", scopeCommitment, 300_000_000n);
  console.log(`  $300 threshold ready: ${cache.hasCachedProof("merchant_42", 300_000_000n)}`);

  console.log(`\n  Cache stats: ${JSON.stringify(cache.stats())}`);

  // ── Summary ──
  console.log("\n=== Payment Flow Impact ===");
  console.log(`  Without cache: ${coldTime}ms per checkout`);
  console.log(`  With cache:    ${hitTime}ms per checkout (proof pre-generated)`);
  console.log(`  Agent pre-warms proofs when receipts change → instant at checkout`);
}

main().catch(e => { console.error(e); process.exit(1); });
