/**
 * Circuit negative tests: verify the circuit REJECTS bad inputs.
 * Each test constructs a valid witness, mutates one thing, and expects failure.
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
  const scopeCommitment = hash(42n);
  const now = BigInt(Math.floor(Date.now() / 1000));

  const purchases = [
    { amount: 100_000_000n, salt: 1001n, ts: now - 86400n * 5n },
    { amount: 150_000_000n, salt: 1002n, ts: now - 86400n * 3n },
    { amount: 200_000_000n, salt: 1003n, ts: now - 86400n },
  ];

  // Build valid tree
  const zeroLeaf = hash(0n, 0n, 0n, 0n, 0n);
  const leaves = new Array(TREE_SIZE).fill(zeroLeaf);
  purchases.forEach((p, i) => {
    leaves[i] = hash(scopeCommitment, p.amount, buyerCommitment, p.salt, p.ts);
  });
  // Padding
  for (let i = purchases.length; i < MAX_PURCHASES; i++) {
    const idx = TREE_SIZE - 1 - (i - purchases.length);
    leaves[idx] = hash(scopeCommitment, 0n, buyerCommitment, 2000n + BigInt(i), 0n);
  }

  const layers = [leaves];
  let current = leaves;
  for (let d = 0; d < MERKLE_DEPTH; d++) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) next.push(hash(current[i], current[i + 1]));
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

  // Build valid base witness
  function buildWitness(overrides = {}) {
    const amounts = [], salts = [], timestamps = [], paths = [], indices = [];
    for (let i = 0; i < MAX_PURCHASES; i++) {
      if (i < purchases.length) {
        amounts.push(purchases[i].amount.toString());
        salts.push(purchases[i].salt.toString());
        timestamps.push(purchases[i].ts.toString());
        const p = getProof(i);
        paths.push(p.pathElements);
        indices.push(p.pathIndices);
      } else {
        const pidx = TREE_SIZE - 1 - (i - purchases.length);
        amounts.push("0");
        salts.push((2000 + i).toString());
        timestamps.push("0");
        const p = getProof(pidx);
        paths.push(p.pathElements);
        indices.push(p.pathIndices);
      }
    }
    return {
      purchaseAmounts: amounts,
      purchaseSalts: salts,
      purchaseTimestamps: timestamps,
      merklePaths: paths,
      merkleIndices: indices,
      buyerSecret: buyerSecret.toString(),
      merkleRoot: merkleRoot.toString(),
      scopeCommitment: scopeCommitment.toString(),
      threshold: "400000000", // $400 — valid (total is $450)
      purchaseCount: "3",
      minTimestamp: "0",
      ...overrides,
    };
  }

  async function expectPass(name, witness) {
    try {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        witness, "build/loyalty_verify_js/loyalty_verify.wasm", "build/loyalty_verify_final.zkey"
      );
      const vkey = JSON.parse(readFileSync("build/verification_key.json", "utf-8"));
      const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
      if (valid) {
        console.log(`  PASS: ${name}`);
        return true;
      } else {
        console.log(`  FAIL: ${name} — proof generated but didn't verify`);
        return false;
      }
    } catch (e) {
      console.log(`  FAIL: ${name} — ${e.message?.slice(0, 80)}`);
      return false;
    }
  }

  async function expectReject(name, witness) {
    try {
      await snarkjs.groth16.fullProve(
        witness, "build/loyalty_verify_js/loyalty_verify.wasm", "build/loyalty_verify_final.zkey"
      );
      console.log(`  FAIL: ${name} — should have rejected but proof was generated`);
      return false;
    } catch {
      console.log(`  PASS: ${name} — correctly rejected`);
      return true;
    }
  }

  let passed = 0, failed = 0;
  function check(ok) { if (ok) passed++; else failed++; }

  console.log("=== Circuit Negative Tests ===\n");

  // Positive baseline
  console.log("Positive cases:");
  check(await expectPass("valid proof (all-time)", buildWitness()));
  check(await expectPass("valid proof (time-bounded)", buildWitness({ minTimestamp: (now - 86400n * 10n).toString() })));

  // Negative: threshold too high
  console.log("\nThreshold tests:");
  check(await expectReject("threshold exceeds spend ($500 > $450)", buildWitness({ threshold: "500000000" })));
  check(await expectReject("threshold exactly at boundary ($451)", buildWitness({ threshold: "451000000" })));

  // Negative: wrong buyer
  console.log("\nBuyer identity tests:");
  check(await expectReject("wrong buyerSecret", buildWitness({ buyerSecret: "99999" })));

  // Negative: wrong scope
  console.log("\nScope tests:");
  check(await expectReject("wrong scopeCommitment", buildWitness({ scopeCommitment: hash(999n).toString() })));

  // Negative: wrong merkle root
  console.log("\nMerkle root tests:");
  check(await expectReject("wrong merkleRoot", buildWitness({ merkleRoot: "123456789" })));

  // Negative: time-bounded with purchases outside window
  console.log("\nTime-bounded tests:");
  // All purchases are 1-5 days old. minTimestamp = 1 day ago should only allow the most recent.
  // Total of just the 1-day-old purchase is $200, less than $400 threshold.
  check(await expectReject("time window excludes old purchases",
    buildWitness({ minTimestamp: (now - 86400n).toString() })));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
