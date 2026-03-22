/**
 * Smoke test for the EdDSA-signed loyalty circuit.
 * Generates merchant EdDSA keys, signs receipts, proves, and verifies.
 */
import { buildPoseidon, buildEddsa, buildBabyjub } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { writeFileSync, readFileSync } from "fs";

const MERKLE_DEPTH = 10;
const MAX_PURCHASES = 8;
const TREE_SIZE = 1 << MERKLE_DEPTH;

async function main() {
  const poseidon = await buildPoseidon();
  const eddsa = await buildEddsa();
  const babyJub = await buildBabyjub();
  const F = poseidon.F;

  const hash = (...inputs) => F.toObject(poseidon(inputs.map(BigInt)));

  // ── Merchant EdDSA keys (Baby Jubjub) ──
  const merchantPrivKey = Buffer.from(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex"
  );
  const merchantPubKey = eddsa.prv2pub(merchantPrivKey);
  const merchantAx = F.toObject(merchantPubKey[0]);
  const merchantAy = F.toObject(merchantPubKey[1]);
  console.log("Merchant EdDSA pubkey generated");

  // ── Test data ──
  const buyerSecret = 12345n;
  const buyerCommitment = hash(buyerSecret);
  const scopeCommitment = hash(42n);
  const now = BigInt(Math.floor(Date.now() / 1000));

  const purchases = [
    { amount: 100_000_000n, salt: 1001n, ts: now - 86400n * 10n },
    { amount: 150_000_000n, salt: 1002n, ts: now - 86400n * 8n },
    { amount: 200_000_000n, salt: 1003n, ts: now - 86400n * 5n },
    { amount: 75_000_000n,  salt: 1004n, ts: now - 86400n * 2n },
    { amount: 50_000_000n,  salt: 1005n, ts: now - 86400n },
  ];

  // ── Compute leaves and sign each one ──
  const leafHashes = [];
  const signatures = [];

  for (const p of purchases) {
    const leafHash = hash(scopeCommitment, p.amount, buyerCommitment, p.salt, p.ts);
    leafHashes.push(leafHash);

    // Sign the leaf hash with merchant's EdDSA key
    const msgF = F.e(leafHash);
    const sig = eddsa.signPoseidon(merchantPrivKey, msgF);
    signatures.push({
      S: sig.S.toString(),
      R8x: F.toObject(sig.R8[0]).toString(),
      R8y: F.toObject(sig.R8[1]).toString(),
    });
  }
  console.log(`${purchases.length} receipts signed`);

  // ── Build Merkle tree ──
  const zeroLeaf = hash(0n, 0n, 0n, 0n, 0n);
  const leaves = new Array(TREE_SIZE).fill(zeroLeaf);
  leafHashes.forEach((lh, i) => { leaves[i] = lh; });

  // Padding leaves at end of tree
  const paddingSigs = [];
  for (let i = purchases.length; i < MAX_PURCHASES; i++) {
    const idx = TREE_SIZE - 1 - (i - purchases.length);
    const padLeaf = hash(scopeCommitment, 0n, buyerCommitment, 2000n + BigInt(i), 0n);
    leaves[idx] = padLeaf;
    // Padding: signature fields are dummy (enabled=0 in circuit)
    paddingSigs.push({ S: "0", R8x: "0", R8y: "0" });
  }

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

  // ── Build witness ──
  const purchaseAmounts = [], purchaseSalts = [], purchaseTimestamps = [];
  const merklePaths = [], merkleIndices = [];
  const sigS = [], sigR8x = [], sigR8y = [];

  for (let i = 0; i < MAX_PURCHASES; i++) {
    if (i < purchases.length) {
      purchaseAmounts.push(purchases[i].amount.toString());
      purchaseSalts.push(purchases[i].salt.toString());
      purchaseTimestamps.push(purchases[i].ts.toString());
      const p = getProof(i);
      merklePaths.push(p.pathElements);
      merkleIndices.push(p.pathIndices);
      sigS.push(signatures[i].S);
      sigR8x.push(signatures[i].R8x);
      sigR8y.push(signatures[i].R8y);
    } else {
      const pidx = TREE_SIZE - 1 - (i - purchases.length);
      purchaseAmounts.push("0");
      purchaseSalts.push((2000 + i).toString());
      purchaseTimestamps.push("0");
      const p = getProof(pidx);
      merklePaths.push(p.pathElements);
      merkleIndices.push(p.pathIndices);
      sigS.push(paddingSigs[i - purchases.length].S);
      sigR8x.push(paddingSigs[i - purchases.length].R8x);
      sigR8y.push(paddingSigs[i - purchases.length].R8y);
    }
  }

  const witness = {
    purchaseAmounts, purchaseSalts, purchaseTimestamps,
    merklePaths, merkleIndices,
    buyerSecret: buyerSecret.toString(),
    sigS, sigR8x, sigR8y,
    merkleRoot: merkleRoot.toString(),
    scopeCommitment: scopeCommitment.toString(),
    threshold: "500000000",
    purchaseCount: "5",
    minTimestamp: "0",
    merchantPubKeyAx: merchantAx.toString(),
    merchantPubKeyAy: merchantAy.toString(),
  };

  writeFileSync("build/input.json", JSON.stringify(witness, null, 2));
  console.log("Witness written");

  // ── Generate + verify proof ──
  console.log("Generating proof (EdDSA circuit, ~82k constraints)...");
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    witness, "build/loyalty_verify_js/loyalty_verify.wasm", "build/loyalty_verify_final.zkey"
  );
  console.log(`Proof generated in ${Date.now() - t0}ms`);

  console.log("Public signals:");
  console.log("  nullifier:", publicSignals[0]);
  console.log("  merkleRoot:", publicSignals[1]);
  console.log("  scopeCommitment:", publicSignals[2]);
  console.log("  threshold:", publicSignals[3]);
  console.log("  purchaseCount:", publicSignals[4]);
  console.log("  minTimestamp:", publicSignals[5]);
  console.log("  merchantAx:", publicSignals[6]);
  console.log("  merchantAy:", publicSignals[7]);

  const vkey = JSON.parse(readFileSync("build/verification_key.json", "utf-8"));
  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log("Proof valid:", valid);

  if (!valid) { console.error("SMOKE TEST FAILED"); process.exit(1); }

  writeFileSync("build/proof.json", JSON.stringify(proof, null, 2));
  writeFileSync("build/public.json", JSON.stringify(publicSignals, null, 2));

  console.log("\nSMOKE TEST PASSED");
}

main().catch(e => { console.error(e); process.exit(1); });
