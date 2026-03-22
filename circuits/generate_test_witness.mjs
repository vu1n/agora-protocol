/**
 * Smoke test: generate a witness, produce a Groth16 proof, verify it.
 * Must pass before any contract work proceeds.
 */
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { writeFileSync, readFileSync } from "fs";

const MERKLE_DEPTH = 10;
const MAX_PURCHASES = 8;
const TREE_SIZE = 1 << MERKLE_DEPTH;

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;
  const hash = (...inputs) => F.toObject(poseidon(inputs.map(BigInt)));

  const buyerSecret = 12345n;
  const buyerCommitment = hash(buyerSecret);
  const scopeCommitment = hash(42n); // merchant or category ID
  const now = BigInt(Math.floor(Date.now() / 1000));

  // 5 purchases with timestamps
  const purchases = [
    { amount: 100_000_000n, salt: 1001n, ts: now - 86400n * 10n },
    { amount: 150_000_000n, salt: 1002n, ts: now - 86400n * 8n },
    { amount: 200_000_000n, salt: 1003n, ts: now - 86400n * 5n },
    { amount: 75_000_000n,  salt: 1004n, ts: now - 86400n * 2n },
    { amount: 50_000_000n,  salt: 1005n, ts: now - 86400n },
  ];

  // Leaf: Poseidon(scopeCommitment, amount, buyerCommitment, salt, timestamp)
  const leafHash = (p) => hash(scopeCommitment, p.amount, buyerCommitment, p.salt, p.ts);

  // Build full tree with real + padding leaves
  const zeroLeaf = hash(0n, 0n, 0n, 0n, 0n);
  const leaves = new Array(TREE_SIZE).fill(zeroLeaf);
  purchases.forEach((p, i) => { leaves[i] = leafHash(p); });

  // Padding leaves at end of tree
  const paddingReceipts = [];
  for (let i = purchases.length; i < MAX_PURCHASES; i++) {
    const pad = { amount: 0n, salt: 2000n + BigInt(i), ts: 0n };
    const idx = TREE_SIZE - 1 - (i - purchases.length);
    leaves[idx] = hash(scopeCommitment, pad.amount, buyerCommitment, pad.salt, pad.ts);
    paddingReceipts.push({ ...pad, idx });
  }

  // Build tree layers
  const layers = [leaves];
  let current = leaves;
  for (let d = 0; d < MERKLE_DEPTH; d++) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(hash(current[i], current[i + 1]));
    }
    layers.push(next);
    current = next;
  }
  const merkleRoot = layers[MERKLE_DEPTH][0];

  // Extract Merkle proof
  function getProof(leafIndex) {
    const pathElements = [], pathIndices = [];
    let idx = leafIndex;
    for (let d = 0; d < MERKLE_DEPTH; d++) {
      pathElements.push(layers[d][idx % 2 === 0 ? idx + 1 : idx - 1].toString());
      pathIndices.push((idx % 2).toString());
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }

  // Build witness
  const purchaseAmounts = [], purchaseSalts = [], purchaseTimestamps = [];
  const merklePaths = [], merkleIndices = [];

  for (let i = 0; i < MAX_PURCHASES; i++) {
    if (i < purchases.length) {
      purchaseAmounts.push(purchases[i].amount.toString());
      purchaseSalts.push(purchases[i].salt.toString());
      purchaseTimestamps.push(purchases[i].ts.toString());
      const p = getProof(i);
      merklePaths.push(p.pathElements);
      merkleIndices.push(p.pathIndices);
    } else {
      const pr = paddingReceipts[i - purchases.length];
      purchaseAmounts.push("0");
      purchaseSalts.push(pr.salt.toString());
      purchaseTimestamps.push("0");
      const p = getProof(pr.idx);
      merklePaths.push(p.pathElements);
      merkleIndices.push(p.pathIndices);
    }
  }

  const witness = {
    purchaseAmounts, purchaseSalts, purchaseTimestamps,
    merklePaths, merkleIndices,
    buyerSecret: buyerSecret.toString(),
    merkleRoot: merkleRoot.toString(),
    scopeCommitment: scopeCommitment.toString(),
    threshold: "500000000",
    purchaseCount: "5",
    minTimestamp: "0", // all-time
  };

  writeFileSync("build/input.json", JSON.stringify(witness, null, 2));
  console.log("Witness written");

  // Generate + verify proof
  console.log("Generating proof...");
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness, "build/loyalty_verify_js/loyalty_verify.wasm", "build/loyalty_verify_final.zkey"
  );
  console.log(`Proof generated in ${Date.now() - t0}ms`);

  // Public signals: [nullifier, merkleRoot, scopeCommitment, threshold, purchaseCount, minTimestamp]
  console.log("Public signals:");
  console.log("  nullifier:", publicSignals[0]);
  console.log("  merkleRoot:", publicSignals[1]);
  console.log("  scopeCommitment:", publicSignals[2]);
  console.log("  threshold:", publicSignals[3]);
  console.log("  purchaseCount:", publicSignals[4]);
  console.log("  minTimestamp:", publicSignals[5]);

  const vkey = JSON.parse(readFileSync("build/verification_key.json", "utf-8"));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Proof valid:", valid);

  if (!valid) { console.error("SMOKE TEST FAILED"); process.exit(1); }

  writeFileSync("build/proof.json", JSON.stringify(proof, null, 2));
  writeFileSync("build/public.json", JSON.stringify(publicSignals, null, 2));

  // Test time-bounded proof (minTimestamp = 15 days ago — should still pass, all purchases within 10 days)
  console.log("\n--- Time-bounded test (last 15 days) ---");
  const witness2 = { ...witness, minTimestamp: (now - 86400n * 15n).toString() };
  const { proof: p2, publicSignals: ps2 } = await snarkjs.groth16.fullProve(
    witness2, "build/loyalty_verify_js/loyalty_verify.wasm", "build/loyalty_verify_final.zkey"
  );
  const valid2 = await snarkjs.groth16.verify(vkey, ps2, p2);
  console.log("Time-bounded proof valid:", valid2);
  if (!valid2) { console.error("TIME-BOUNDED TEST FAILED"); process.exit(1); }

  console.log("\nSMOKE TEST PASSED");
}

main().catch(e => { console.error(e); process.exit(1); });
