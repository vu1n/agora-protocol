pragma circom 2.0.0;

include "../../sen-commerce/circuits/node_modules/circomlib/circuits/poseidon.circom";
include "../../sen-commerce/circuits/node_modules/circomlib/circuits/comparators.circom";
include "../../sen-commerce/circuits/node_modules/circomlib/circuits/mux1.circom";

/**
 * Agora Loyalty Verification Circuit (Groth16)
 *
 * Proves a buyer has spent at least `threshold` with a seller
 * without revealing purchase amounts, identity, or history.
 *
 * Trust model:
 * - Merchant publishes Merkle root of purchase leaves on-chain
 * - Buyer proves inclusion of their purchases against that root
 * - Nullifier = Poseidon(buyerSecret, merkleRoot) prevents replay
 * - buyerCommitment in leaf prevents impersonation
 *
 * Public inputs:  merkleRoot, sellerCommitment, threshold, purchaseCount
 * Public outputs: nullifier, valid
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

        // pathIndex=0: hash(current, sibling)  — current on left
        // pathIndex=1: hash(sibling, current)  — current on right
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

template LoyaltyVerify(maxPurchases, merkleDepth) {
    // ── Private inputs ──
    signal input purchaseAmounts[maxPurchases];
    signal input purchaseSalts[maxPurchases];
    signal input merklePaths[maxPurchases][merkleDepth];
    signal input merkleIndices[maxPurchases][merkleDepth];
    signal input buyerSecret;

    // ── Public inputs ──
    signal input merkleRoot;
    signal input sellerCommitment;
    signal input threshold;
    signal input purchaseCount;

    // ── Public outputs ──
    signal output nullifier;
    signal output valid;

    // ── 1. Compute buyer commitment from secret ──
    component buyerCommitmentHasher = Poseidon(1);
    buyerCommitmentHasher.inputs[0] <== buyerSecret;
    signal buyerCommitment;
    buyerCommitment <== buyerCommitmentHasher.out;

    // ── 2. Verify each purchase is in the Merkle tree ──
    component merkleCheckers[maxPurchases];
    component purchaseHashers[maxPurchases];

    for (var i = 0; i < maxPurchases; i++) {
        // Hash purchase leaf: Poseidon(sellerCommitment, amount, buyerCommitment, salt)
        purchaseHashers[i] = Poseidon(4);
        purchaseHashers[i].inputs[0] <== sellerCommitment;
        purchaseHashers[i].inputs[1] <== purchaseAmounts[i];
        purchaseHashers[i].inputs[2] <== buyerCommitment;
        purchaseHashers[i].inputs[3] <== purchaseSalts[i];

        // Verify Merkle proof
        merkleCheckers[i] = MerkleTreeChecker(merkleDepth);
        merkleCheckers[i].leaf <== purchaseHashers[i].out;
        for (var j = 0; j < merkleDepth; j++) {
            merkleCheckers[i].pathElements[j] <== merklePaths[i][j];
            merkleCheckers[i].pathIndices[j] <== merkleIndices[i][j];
        }

        // Constrain all Merkle proofs against the public root
        merkleCheckers[i].root === merkleRoot;
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

    valid <== gte.out;
    valid === 1;

    // ── 5. Range check purchaseCount ──
    component countCheck = LessThan(8);
    countCheck.in[0] <== purchaseCount;
    countCheck.in[1] <== maxPurchases + 1;
    countCheck.out === 1;

    // ── 6. Compute nullifier: bound to buyer identity + tree state ──
    component nullifierHasher = Poseidon(2);
    nullifierHasher.inputs[0] <== buyerSecret;
    nullifierHasher.inputs[1] <== merkleRoot;
    nullifier <== nullifierHasher.out;
}

// 8 purchases max, Merkle depth 10 (1024 leaves)
component main {public [merkleRoot, sellerCommitment, threshold, purchaseCount]} = LoyaltyVerify(8, 10);
