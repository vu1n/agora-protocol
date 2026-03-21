/**
 * Generates a test witness for the loyalty_verify circuit,
 * then produces and verifies a Groth16 proof.
 *
 * This is the Phase 1 smoke test — must pass before proceeding.
 */
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { readFileSync, writeFileSync } from "fs";

const MERKLE_DEPTH = 10;
const MAX_PURCHASES = 8;
const TREE_SIZE = 1 << MERKLE_DEPTH; // 1024

async function main() {
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  // Helper: Poseidon hash returning bigint
  const hash = (...inputs) => F.toObject(poseidon(inputs.map(BigInt)));

  // ── Test data ──
  const buyerSecret = 12345n;
  const buyerCommitment = hash(buyerSecret);
  const sellerCommitment = hash(42n); // seller ID hashed

  // 5 real purchases, 3 padding slots
  const purchases = [
    { amount: 100_000_000n, salt: 1001n }, // $100
    { amount: 150_000_000n, salt: 1002n }, // $150
    { amount: 200_000_000n, salt: 1003n }, // $200
    { amount: 75_000_000n,  salt: 1004n }, // $75
    { amount: 50_000_000n,  salt: 1005n }, // $50
  ];
  // Total: $575 — proving threshold of $500

  // ── Build Merkle tree ──
  // Compute leaves for real purchases
  const purchaseLeaves = purchases.map(p =>
    hash(sellerCommitment, p.amount, buyerCommitment, p.salt)
  );

  // Fill tree with zero leaves
  const ZERO_LEAF = hash(0n, 0n, 0n, 0n);
  const leaves = new Array(TREE_SIZE).fill(ZERO_LEAF);
  purchaseLeaves.forEach((leaf, i) => { leaves[i] = leaf; });

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
  console.log("Merkle root:", merkleRoot.toString());

  // ── Build Merkle proofs for each slot ──
  function getMerkleProof(leafIndex) {
    const pathElements = [];
    const pathIndices = [];
    let idx = leafIndex;
    for (let d = 0; d < MERKLE_DEPTH; d++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathElements.push(layers[d][siblingIdx].toString());
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }

  // ── Construct witness ──
  const purchaseAmounts = [];
  const purchaseSalts = [];
  const merklePaths = [];
  const merkleIndices = [];

  for (let i = 0; i < MAX_PURCHASES; i++) {
    if (i < purchases.length) {
      purchaseAmounts.push(purchases[i].amount.toString());
      purchaseSalts.push(purchases[i].salt.toString());
      const proof = getMerkleProof(i);
      merklePaths.push(proof.pathElements);
      merkleIndices.push(proof.pathIndices.map(String));
    } else {
      // Padding: use leaf index 0 with amount 0
      // We need a valid Merkle proof for a zero-amount leaf
      // Use a dedicated padding leaf at a unique index
      const paddingIdx = TREE_SIZE - 1 - (i - purchases.length); // use end of tree
      const paddingLeaf = hash(sellerCommitment, 0n, buyerCommitment, BigInt(2000 + i));
      leaves[paddingIdx] = paddingLeaf;
      purchaseAmounts.push("0");
      purchaseSalts.push((2000 + i).toString());
      // NOTE: We need to rebuild the tree with padding leaves.
      // For simplicity, we'll rebuild after setting all padding leaves.
    }
  }

  // Rebuild tree with padding leaves included
  const leaves2 = [...leaves];
  // Set padding leaves
  for (let i = purchases.length; i < MAX_PURCHASES; i++) {
    const paddingIdx = TREE_SIZE - 1 - (i - purchases.length);
    leaves2[paddingIdx] = hash(sellerCommitment, 0n, buyerCommitment, BigInt(2000 + i));
  }

  const layers2 = [leaves2];
  let cur2 = leaves2;
  for (let d = 0; d < MERKLE_DEPTH; d++) {
    const next = [];
    for (let i = 0; i < cur2.length; i += 2) {
      next.push(hash(cur2[i], cur2[i + 1]));
    }
    layers2.push(next);
    cur2 = next;
  }
  const merkleRoot2 = layers2[MERKLE_DEPTH][0];

  // Rebuild Merkle proofs with the updated tree
  function getMerkleProof2(leafIndex) {
    const pathElements = [];
    const pathIndices = [];
    let idx = leafIndex;
    for (let d = 0; d < MERKLE_DEPTH; d++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathElements.push(layers2[d][siblingIdx].toString());
      pathIndices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { pathElements, pathIndices };
  }

  // Re-fill witness with corrected tree
  const merklePaths2 = [];
  const merkleIndices2 = [];
  const purchaseSalts2 = [];
  const purchaseAmounts2 = [];

  for (let i = 0; i < MAX_PURCHASES; i++) {
    if (i < purchases.length) {
      purchaseAmounts2.push(purchases[i].amount.toString());
      purchaseSalts2.push(purchases[i].salt.toString());
      const proof = getMerkleProof2(i);
      merklePaths2.push(proof.pathElements);
      merkleIndices2.push(proof.pathIndices.map(String));
    } else {
      const paddingIdx = TREE_SIZE - 1 - (i - purchases.length);
      purchaseAmounts2.push("0");
      purchaseSalts2.push((2000 + i).toString());
      const proof = getMerkleProof2(paddingIdx);
      merklePaths2.push(proof.pathElements);
      merkleIndices2.push(proof.pathIndices.map(String));
    }
  }

  const witness = {
    purchaseAmounts: purchaseAmounts2,
    purchaseSalts: purchaseSalts2,
    merklePaths: merklePaths2,
    merkleIndices: merkleIndices2,
    buyerSecret: buyerSecret.toString(),
    merkleRoot: merkleRoot2.toString(),
    sellerCommitment: sellerCommitment.toString(),
    threshold: "500000000", // $500
    purchaseCount: "5",
  };

  writeFileSync("build/input.json", JSON.stringify(witness, null, 2));
  console.log("Witness written to build/input.json");

  // ── Generate proof ──
  console.log("\nGenerating Groth16 proof...");
  const startTime = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness,
    "build/loyalty_verify_js/loyalty_verify.wasm",
    "build/loyalty_verify_final.zkey"
  );
  const elapsed = Date.now() - startTime;
  console.log(`Proof generated in ${elapsed}ms`);

  // Public signals: [nullifier, valid, merkleRoot, sellerCommitment, threshold, purchaseCount]
  console.log("\nPublic signals:");
  console.log("  nullifier:", publicSignals[0]);
  console.log("  valid:", publicSignals[1]);
  console.log("  merkleRoot:", publicSignals[2]);
  console.log("  sellerCommitment:", publicSignals[3]);
  console.log("  threshold:", publicSignals[4]);
  console.log("  purchaseCount:", publicSignals[5]);

  // ── Verify proof ──
  console.log("\nVerifying proof...");
  const vkey = JSON.parse(readFileSync("build/verification_key.json", "utf-8"));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Proof valid:", valid);

  if (!valid) {
    console.error("SMOKE TEST FAILED: Proof did not verify!");
    process.exit(1);
  }

  // Save proof for use in contract tests
  writeFileSync("build/proof.json", JSON.stringify(proof, null, 2));
  writeFileSync("build/public.json", JSON.stringify(publicSignals, null, 2));
  console.log("\nSaved proof.json and public.json");
  console.log("\nSMOKE TEST PASSED");
}

main().catch(e => { console.error(e); process.exit(1); });
