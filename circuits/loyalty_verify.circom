pragma circom 2.0.0;

include "../../sen-commerce/circuits/node_modules/circomlib/circuits/poseidon.circom";
include "../../sen-commerce/circuits/node_modules/circomlib/circuits/comparators.circom";
include "../../sen-commerce/circuits/node_modules/circomlib/circuits/mux1.circom";
include "../../sen-commerce/circuits/node_modules/circomlib/circuits/eddsaposeidon.circom";

/**
 * Agora Unified Spend Verification Circuit (Groth16)
 *
 * Proves a buyer spent at least `threshold` within a scope, optionally
 * within a time window, with merchant-signed receipts.
 *
 * Security properties:
 *   - Receipts are EdDSA-signed by the merchant (Baby Jubjub / Poseidon)
 *   - Merkle root is a public input (cross-checked on-chain vs registry)
 *   - Nullifier = Poseidon(buyerSecret, merkleRoot) prevents replay
 *   - buyerCommitment in leaf prevents impersonation
 *   - Leaf uniqueness enforced: no receipt counted twice
 *   - Padding slots (amount=0) exempt from time + signature checks
 *
 * Leaf format: Poseidon(scopeCommitment, amount, buyerCommitment, salt, timestamp)
 *
 * Public inputs:  merkleRoot, scopeCommitment, threshold, purchaseCount, minTimestamp, merchantPubKeyAx, merchantPubKeyAy
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
    // EdDSA signature per receipt: (S, R8x, R8y)
    signal input sigS[maxPurchases];
    signal input sigR8x[maxPurchases];
    signal input sigR8y[maxPurchases];

    // ── Public inputs ──
    signal input merkleRoot;
    signal input scopeCommitment;
    signal input threshold;
    signal input purchaseCount;
    signal input minTimestamp;
    // Merchant's EdDSA public key (Baby Jubjub point)
    signal input merchantPubKeyAx;
    signal input merchantPubKeyAy;

    // ── Public outputs ──
    signal output nullifier;

    // ── 1. Compute buyer commitment from secret ──
    component buyerCommitmentHasher = Poseidon(1);
    buyerCommitmentHasher.inputs[0] <== buyerSecret;
    signal buyerCommitment;
    buyerCommitment <== buyerCommitmentHasher.out;

    // ── 2. Verify each purchase: Merkle inclusion, time, signature, uniqueness ──
    component merkleCheckers[maxPurchases];
    component purchaseHashers[maxPurchases];
    component timeChecks[maxPurchases];
    component isZeroAmount[maxPurchases];
    component timeOrPadding[maxPurchases];
    component sigVerifiers[maxPurchases];

    // Compute leaf index from path indices for uniqueness check
    signal leafIndex[maxPurchases];

    for (var i = 0; i < maxPurchases; i++) {
        // Leaf hash: Poseidon(scopeCommitment, amount, buyerCommitment, salt, timestamp)
        purchaseHashers[i] = Poseidon(5);
        purchaseHashers[i].inputs[0] <== scopeCommitment;
        purchaseHashers[i].inputs[1] <== purchaseAmounts[i];
        purchaseHashers[i].inputs[2] <== buyerCommitment;
        purchaseHashers[i].inputs[3] <== purchaseSalts[i];
        purchaseHashers[i].inputs[4] <== purchaseTimestamps[i];

        // Merkle inclusion proof
        merkleCheckers[i] = MerkleTreeChecker(merkleDepth);
        merkleCheckers[i].leaf <== purchaseHashers[i].out;
        for (var j = 0; j < merkleDepth; j++) {
            merkleCheckers[i].pathElements[j] <== merklePaths[i][j];
            merkleCheckers[i].pathIndices[j] <== merkleIndices[i][j];
        }
        merkleCheckers[i].root === merkleRoot;

        // Time constraint (padding exempt)
        timeChecks[i] = GreaterEqThan(64);
        timeChecks[i].in[0] <== purchaseTimestamps[i];
        timeChecks[i].in[1] <== minTimestamp;

        isZeroAmount[i] = IsZero();
        isZeroAmount[i].in <== purchaseAmounts[i];

        timeOrPadding[i] = Mux1();
        timeOrPadding[i].c[0] <== timeChecks[i].out;
        timeOrPadding[i].c[1] <== 1;
        timeOrPadding[i].s <== isZeroAmount[i].out;
        timeOrPadding[i].out === 1;

        // EdDSA signature verification
        // Message = leaf hash. Padding slots have enabled=0 (skip verification).
        sigVerifiers[i] = EdDSAPoseidonVerifier();
        sigVerifiers[i].enabled <== 1 - isZeroAmount[i].out; // enabled for non-zero amounts
        sigVerifiers[i].Ax <== merchantPubKeyAx;
        sigVerifiers[i].Ay <== merchantPubKeyAy;
        sigVerifiers[i].S <== sigS[i];
        sigVerifiers[i].R8x <== sigR8x[i];
        sigVerifiers[i].R8y <== sigR8y[i];
        sigVerifiers[i].M <== purchaseHashers[i].out;

        // Compute leaf index from path indices (binary → integer)
        var idx = 0;
        for (var j = 0; j < merkleDepth; j++) {
            idx += merkleIndices[i][j] * (1 << j);
        }
        leafIndex[i] <== idx;
    }

    // ── 3. Leaf uniqueness: no two active slots use the same tree position ──
    // For each pair of active slots, their leaf indices must differ.
    // Uses O(n²) IsEqual checks, but n=8 so only 28 pairs.
    var NUM_PAIRS = maxPurchases * (maxPurchases - 1) / 2;
    component pairEq[NUM_PAIRS];
    signal bothActive[NUM_PAIRS];
    var pairIdx = 0;

    for (var i = 0; i < maxPurchases; i++) {
        for (var j = i + 1; j < maxPurchases; j++) {
            pairEq[pairIdx] = IsEqual();
            pairEq[pairIdx].in[0] <== leafIndex[i];
            pairEq[pairIdx].in[1] <== leafIndex[j];

            // If both active AND same index → violation
            bothActive[pairIdx] <== (1 - isZeroAmount[i].out) * (1 - isZeroAmount[j].out);
            bothActive[pairIdx] * pairEq[pairIdx].out === 0;

            pairIdx += 1;
        }
    }

    // ── 4. Sum purchase amounts ──
    var sum = 0;
    for (var i = 0; i < maxPurchases; i++) {
        sum += purchaseAmounts[i];
    }

    // ── 5. Verify sum >= threshold ──
    component gte = GreaterEqThan(64);
    gte.in[0] <== sum;
    gte.in[1] <== threshold;
    gte.out === 1;

    // ── 6. Range check purchaseCount ──
    component countNonNeg = GreaterEqThan(64);
    countNonNeg.in[0] <== purchaseCount;
    countNonNeg.in[1] <== 0;
    countNonNeg.out === 1;

    component countCheck = LessThan(8);
    countCheck.in[0] <== purchaseCount;
    countCheck.in[1] <== maxPurchases + 1;
    countCheck.out === 1;

    // ── 7. Nullifier: bound to buyer + tree state ──
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== buyerSecret;
    nullifierHasher.inputs[1] <== merkleRoot;
    nullifier <== nullifierHasher.out;
}

// 8 purchases max, Merkle depth 10 (1024 leaves)
component main {public [merkleRoot, scopeCommitment, threshold, purchaseCount, minTimestamp, merchantPubKeyAx, merchantPubKeyAy]} = AgoraVerify(8, 10);
