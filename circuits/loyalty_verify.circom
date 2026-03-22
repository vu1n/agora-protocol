pragma circom 2.0.0;

include "../../sen-commerce/circuits/node_modules/circomlib/circuits/poseidon.circom";
include "../../sen-commerce/circuits/node_modules/circomlib/circuits/comparators.circom";
include "../../sen-commerce/circuits/node_modules/circomlib/circuits/mux1.circom";

/**
 * Agora Unified Spend Verification Circuit (Groth16)
 *
 * Proves a buyer spent at least `threshold` within a scope (single merchant
 * OR cross-merchant category) and optionally within a time window.
 *
 * Use cases:
 *   - Per-merchant loyalty: scopeCommitment = Poseidon(sellerId)
 *   - Category LTV:         scopeCommitment = Poseidon("coffee_shops")
 *   - Time-bounded:         minTimestamp > 0
 *   - All-time:             minTimestamp = 0
 *
 * Leaf format: Poseidon(scopeCommitment, amount, buyerCommitment, salt, timestamp)
 *
 * Public inputs:  merkleRoot, scopeCommitment, threshold, purchaseCount, minTimestamp
 * Public outputs: nullifier
 */

template MerkleTreeChecker(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component leftMux[levels];
    component rightMux[levels];
    component hashers[levels];

    for (var i = 0; i < levels; i++) {
        hashers[i] = Poseidon(2);
        leftMux[i] = Mux1();
        rightMux[i] = Mux1();

        leftMux[i].s <== pathIndices[i];
        rightMux[i].s <== pathIndices[i];

        if (i == 0) {
            leftMux[i].c[0] <== leaf;
            leftMux[i].c[1] <== pathElements[i];
            rightMux[i].c[0] <== pathElements[i];
            rightMux[i].c[1] <== leaf;
        } else {
            leftMux[i].c[0] <== hashers[i-1].out;
            leftMux[i].c[1] <== pathElements[i];
            rightMux[i].c[0] <== pathElements[i];
            rightMux[i].c[1] <== hashers[i-1].out;
        }

        hashers[i].inputs[0] <== leftMux[i].out;
        hashers[i].inputs[1] <== rightMux[i].out;
    }

    root <== hashers[levels-1].out;
}

template AgoraVerify(maxPurchases, merkleDepth) {
    // ── Private inputs ──
    signal input purchaseAmounts[maxPurchases];
    signal input purchaseSalts[maxPurchases];
    signal input purchaseTimestamps[maxPurchases];
    signal input merklePaths[maxPurchases][merkleDepth];
    signal input merkleIndices[maxPurchases][merkleDepth];
    signal input buyerSecret;

    // ── Public inputs ──
    signal input merkleRoot;
    signal input scopeCommitment;   // Poseidon(sellerId) OR Poseidon(categoryId)
    signal input threshold;          // minimum spend to prove
    signal input purchaseCount;      // how many real purchases (rest are zero-padded)
    signal input minTimestamp;       // 0 = all time, >0 = only purchases after this

    // ── Public outputs ──
    signal output nullifier;

    // ── 1. Compute buyer commitment from secret ──
    component buyerCommitmentHasher = Poseidon(1);
    buyerCommitmentHasher.inputs[0] <== buyerSecret;
    signal buyerCommitment;
    buyerCommitment <== buyerCommitmentHasher.out;

    // ── 2. Verify each purchase leaf and time constraint ──
    component merkleCheckers[maxPurchases];
    component purchaseHashers[maxPurchases];
    component timeChecks[maxPurchases];
    component isZeroAmount[maxPurchases];
    component timeOrPadding[maxPurchases];

    for (var i = 0; i < maxPurchases; i++) {
        // Leaf: Poseidon(scopeCommitment, amount, buyerCommitment, salt, timestamp)
        purchaseHashers[i] = Poseidon(5);
        purchaseHashers[i].inputs[0] <== scopeCommitment;
        purchaseHashers[i].inputs[1] <== purchaseAmounts[i];
        purchaseHashers[i].inputs[2] <== buyerCommitment;
        purchaseHashers[i].inputs[3] <== purchaseSalts[i];
        purchaseHashers[i].inputs[4] <== purchaseTimestamps[i];

        // Merkle inclusion
        merkleCheckers[i] = MerkleTreeChecker(merkleDepth);
        merkleCheckers[i].leaf <== purchaseHashers[i].out;
        for (var j = 0; j < merkleDepth; j++) {
            merkleCheckers[i].pathElements[j] <== merklePaths[i][j];
            merkleCheckers[i].pathIndices[j] <== merkleIndices[i][j];
        }
        merkleCheckers[i].root === merkleRoot;

        // Time constraint: timestamp >= minTimestamp
        // Padding slots (amount=0) are exempt — they always pass.
        timeChecks[i] = GreaterEqThan(64);
        timeChecks[i].in[0] <== purchaseTimestamps[i];
        timeChecks[i].in[1] <== minTimestamp;

        // isPadding = (amount == 0)
        isZeroAmount[i] = IsZero();
        isZeroAmount[i].in <== purchaseAmounts[i];

        // timeOk = isPadding ? 1 : timeCheck.out
        timeOrPadding[i] = Mux1();
        timeOrPadding[i].c[0] <== timeChecks[i].out; // active slot: real check
        timeOrPadding[i].c[1] <== 1;                  // padding: always pass
        timeOrPadding[i].s <== isZeroAmount[i].out;
        timeOrPadding[i].out === 1;
    }

    // ── 3. Sum purchase amounts ──
    var sum = 0;
    for (var i = 0; i < maxPurchases; i++) {
        sum += purchaseAmounts[i];
    }

    // ── 4. Verify sum >= threshold ──
    component gte = GreaterEqThan(64);
    gte.in[0] <== sum;
    gte.in[1] <== threshold;
    gte.out === 1;

    // ── 5. Range check purchaseCount (constrained non-negative for LessThan safety) ──
    component countNonNeg = GreaterEqThan(64);
    countNonNeg.in[0] <== purchaseCount;
    countNonNeg.in[1] <== 0;
    countNonNeg.out === 1;

    component countCheck = LessThan(8);
    countCheck.in[0] <== purchaseCount;
    countCheck.in[1] <== maxPurchases + 1;
    countCheck.out === 1;

    // ── 6. Nullifier: bound to buyer + tree state ──
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== buyerSecret;
    nullifierHasher.inputs[1] <== merkleRoot;
    nullifier <== nullifierHasher.out;
}

// 8 purchases max, Merkle depth 10 (1024 leaves)
component main {public [merkleRoot, scopeCommitment, threshold, purchaseCount, minTimestamp]} = AgoraVerify(8, 10);
