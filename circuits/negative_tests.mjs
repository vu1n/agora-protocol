/**
 * Circuit negative tests with EdDSA signatures.
 * Verifies the circuit REJECTS bad inputs including signature forgery.
 */
import { buildPoseidon, buildEddsa, buildBabyjub } from "circomlibjs";
import * as snarkjs from "snarkjs";
import { readFileSync } from "fs";

const MERKLE_DEPTH = 10;
const MAX_PURCHASES = 8;
const TREE_SIZE = 1 << MERKLE_DEPTH;

async function main() {
  const poseidon = await buildPoseidon();
  const eddsa = await buildEddsa();
  const babyJub = await buildBabyjub();
  const F = poseidon.F;
  const hash = (...inputs) => F.toObject(poseidon(inputs.map(BigInt)));

  // Merchant EdDSA keys
  const merchantPrivKey = Buffer.from(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex"
  );
  const merchantPubKey = eddsa.prv2pub(merchantPrivKey);
  const merchantAx = F.toObject(merchantPubKey[0]);
  const merchantAy = F.toObject(merchantPubKey[1]);

  // Attacker's EdDSA keys (for forgery tests)
  const attackerPrivKey = Buffer.from(
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", "hex"
  );
  const attackerPubKey = eddsa.prv2pub(attackerPrivKey);
  const attackerAx = F.toObject(attackerPubKey[0]);
  const attackerAy = F.toObject(attackerPubKey[1]);

  const buyerSecret = 12345n;
  const buyerCommitment = hash(buyerSecret);
  const scopeCommitment = hash(42n);
  const now = BigInt(Math.floor(Date.now() / 1000));

  const purchases = [
    { amount: 100_000_000n, salt: 1001n, ts: now - 86400n * 5n },
    { amount: 150_000_000n, salt: 1002n, ts: now - 86400n * 3n },
    { amount: 200_000_000n, salt: 1003n, ts: now - 86400n },
  ];

  // Sign each receipt with merchant key
  const leafHashes = [];
  const signatures = [];
  for (const p of purchases) {
    const lh = hash(scopeCommitment, p.amount, buyerCommitment, p.salt, p.ts);
    leafHashes.push(lh);
    const sig = eddsa.signPoseidon(merchantPrivKey, F.e(lh));
    signatures.push({ S: sig.S.toString(), R8x: F.toObject(sig.R8[0]).toString(), R8y: F.toObject(sig.R8[1]).toString() });
  }

  // Build tree
  const zeroLeaf = hash(0n, 0n, 0n, 0n, 0n);
  const leaves = new Array(TREE_SIZE).fill(zeroLeaf);
  leafHashes.forEach((lh, i) => { leaves[i] = lh; });
  for (let i = purchases.length; i < MAX_PURCHASES; i++) {
    leaves[TREE_SIZE - 1 - (i - purchases.length)] = hash(scopeCommitment, 0n, buyerCommitment, 2000n + BigInt(i), 0n);
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

  function buildWitness(overrides = {}) {
    const amounts = [], salts = [], timestamps = [], paths = [], indices = [];
    const sS = [], sR8x = [], sR8y = [];

    for (let i = 0; i < MAX_PURCHASES; i++) {
      if (i < purchases.length) {
        amounts.push(purchases[i].amount.toString());
        salts.push(purchases[i].salt.toString());
        timestamps.push(purchases[i].ts.toString());
        sS.push(signatures[i].S);
        sR8x.push(signatures[i].R8x);
        sR8y.push(signatures[i].R8y);
        const p = getProof(i);
        paths.push(p.pathElements);
        indices.push(p.pathIndices);
      } else {
        const pidx = TREE_SIZE - 1 - (i - purchases.length);
        amounts.push("0");
        salts.push((2000 + i).toString());
        timestamps.push("0");
        sS.push("0");
        sR8x.push("0");
        sR8y.push("0");
        const p = getProof(pidx);
        paths.push(p.pathElements);
        indices.push(p.pathIndices);
      }
    }
    return {
      purchaseAmounts: amounts, purchaseSalts: salts, purchaseTimestamps: timestamps,
      merklePaths: paths, merkleIndices: indices,
      buyerSecret: buyerSecret.toString(),
      sigS: sS, sigR8x: sR8x, sigR8y: sR8y,
      merkleRoot: merkleRoot.toString(),
      scopeCommitment: scopeCommitment.toString(),
      threshold: "400000000",
      purchaseCount: "3",
      minTimestamp: "0",
      merchantPubKeyAx: merchantAx.toString(),
      merchantPubKeyAy: merchantAy.toString(),
      ...overrides,
    };
  }

  const WASM = "build/loyalty_verify_js/loyalty_verify.wasm";
  const ZKEY = "build/loyalty_verify_final.zkey";
  const vkey = JSON.parse(readFileSync("build/verification_key.json", "utf-8"));

  async function expectPass(name, witness) {
    try {
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
      const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
      if (valid) { console.log(`  PASS: ${name}`); return true; }
      console.log(`  FAIL: ${name} — proof didn't verify`); return false;
    } catch (e) {
      console.log(`  FAIL: ${name} — ${e.message?.slice(0, 80)}`); return false;
    }
  }

  async function expectReject(name, witness) {
    try {
      await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
      console.log(`  FAIL: ${name} — should have rejected`); return false;
    } catch {
      console.log(`  PASS: ${name} — correctly rejected`); return true;
    }
  }

  let passed = 0, failed = 0;
  const check = (ok) => { if (ok) passed++; else failed++; };

  console.log("=== Circuit Negative Tests (EdDSA) ===\n");

  // Positive baseline
  console.log("Positive cases:");
  check(await expectPass("valid proof (all-time, signed)", buildWitness()));
  check(await expectPass("valid proof (time-bounded)", buildWitness({ minTimestamp: (now - 86400n * 10n).toString() })));

  // Threshold
  console.log("\nThreshold tests:");
  check(await expectReject("threshold exceeds spend ($500 > $450)", buildWitness({ threshold: "500000000" })));

  // Wrong buyer
  console.log("\nBuyer identity tests:");
  check(await expectReject("wrong buyerSecret", buildWitness({ buyerSecret: "99999" })));

  // Wrong scope
  console.log("\nScope tests:");
  check(await expectReject("wrong scopeCommitment", buildWitness({ scopeCommitment: hash(999n).toString() })));

  // Wrong merkle root
  console.log("\nMerkle root tests:");
  check(await expectReject("wrong merkleRoot", buildWitness({ merkleRoot: "123456789" })));

  // Time-bounded
  console.log("\nTime-bounded tests:");
  check(await expectReject("time window excludes old purchases",
    buildWitness({ minTimestamp: (now - 86400n).toString() })));

  // EdDSA signature forgery tests
  console.log("\nEdDSA signature tests:");

  // Wrong signing key — sign with attacker's key, present merchant's pubkey
  const attackerSigs = [];
  for (const lh of leafHashes) {
    const sig = eddsa.signPoseidon(attackerPrivKey, F.e(lh));
    attackerSigs.push({ S: sig.S.toString(), R8x: F.toObject(sig.R8[0]).toString(), R8y: F.toObject(sig.R8[1]).toString() });
  }
  const wrongSignerWitness = buildWitness({
    sigS: [...attackerSigs.map(s => s.S), "0", "0", "0", "0", "0"],
    sigR8x: [...attackerSigs.map(s => s.R8x), "0", "0", "0", "0", "0"],
    sigR8y: [...attackerSigs.map(s => s.R8y), "0", "0", "0", "0", "0"],
  });
  check(await expectReject("wrong signing key (attacker signs, merchant pubkey)", wrongSignerWitness));

  // Tampered signature — flip one bit in S
  const tamperedSigs = [...signatures];
  const originalS = BigInt(tamperedSigs[0].S);
  tamperedSigs[0] = { ...tamperedSigs[0], S: (originalS + 1n).toString() };
  const tamperedWitness = buildWitness({
    sigS: [...tamperedSigs.map(s => s.S), "0", "0", "0", "0", "0"],
  });
  check(await expectReject("tampered signature (S incremented by 1)", tamperedWitness));

  // Self-signed with attacker's pubkey (should fail because contract checks pubkey,
  // but at circuit level this would pass — the circuit verifies the sig against
  // whatever pubkey is provided. The on-chain check prevents this.)
  // For completeness, verify the circuit DOES accept a self-consistent attacker proof:
  const selfSignedWitness = buildWitness({
    sigS: [...attackerSigs.map(s => s.S), "0", "0", "0", "0", "0"],
    sigR8x: [...attackerSigs.map(s => s.R8x), "0", "0", "0", "0", "0"],
    sigR8y: [...attackerSigs.map(s => s.R8y), "0", "0", "0", "0", "0"],
    merchantPubKeyAx: attackerAx.toString(),
    merchantPubKeyAy: attackerAy.toString(),
  });
  check(await expectPass("self-signed with attacker key (circuit passes, contract rejects)", selfSignedWitness));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  console.log("Note: self-signed attacker proof passes circuit but fails on-chain (EdDSA key mismatch)");
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
