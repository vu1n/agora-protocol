// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MerchantRegistry} from "./MerchantRegistry.sol";

interface IGroth16Verifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[6] calldata _pubSignals
    ) external view returns (bool);
}

/// @title LoyaltyManager
/// @notice Verifies ZK loyalty proofs on-chain. The Merkle root is read from
///         MerchantRegistry (not supplied by the caller) to prevent fabrication.
///         Nullifiers prevent replay — one proof per buyer per root version.
///
/// Public signals layout from circuit:
///   [0] nullifier
///   [1] valid (must be 1)
///   [2] merkleRoot
///   [3] sellerCommitment
///   [4] threshold
///   [5] purchaseCount
contract LoyaltyManager {
    IGroth16Verifier public immutable verifier;
    MerchantRegistry public immutable registry;

    mapping(uint256 => bool) public usedNullifiers;
    uint256 public verificationCount;

    event LoyaltyProofVerified(
        bytes32 indexed merchantAgentId,
        uint256 sellerCommitment,
        uint256 threshold,
        uint256 nullifier,
        uint256 timestamp
    );

    error InvalidProof();
    error NullifierAlreadyUsed();
    error MerchantHasNoRoot();
    error RootMismatch();
    error ProofNotValid();

    constructor(address _verifier, address _registry) {
        verifier = IGroth16Verifier(_verifier);
        registry = MerchantRegistry(_registry);
    }

    /// @notice Verify a ZK loyalty proof. All public signals come from the caller,
    ///         but the merkleRoot is cross-checked against the on-chain registry.
    ///         The nullifier is a circuit output — if it doesn't match
    ///         Poseidon(buyerSecret, merkleRoot), the proof itself is invalid.
    function verifyLoyaltyFull(
        uint[2] calldata a,
        uint[2][2] calldata b,
        uint[2] calldata c,
        uint[6] calldata pubSignals,
        bytes32 merchantAgentId
    ) external returns (bool) {
        // pubSignals: [nullifier, valid, merkleRoot, sellerCommitment, threshold, purchaseCount]
        uint256 nullifier = pubSignals[0];
        uint256 validFlag = pubSignals[1];
        uint256 proofRoot = pubSignals[2];

        // 1. valid flag must be 1
        if (validFlag != 1) revert ProofNotValid();

        // 2. Cross-check merkleRoot against registry
        bytes32 registryRoot = registry.getPurchaseRoot(merchantAgentId);
        if (registryRoot == bytes32(0)) revert MerchantHasNoRoot();
        if (uint256(registryRoot) != proofRoot) revert RootMismatch();

        // 3. Check nullifier not used
        if (usedNullifiers[nullifier]) revert NullifierAlreadyUsed();

        // 4. Verify the Groth16 proof
        bool valid = verifier.verifyProof(a, b, c, pubSignals);
        if (!valid) revert InvalidProof();

        // 5. Mark nullifier used
        usedNullifiers[nullifier] = true;
        verificationCount++;

        emit LoyaltyProofVerified(
            merchantAgentId,
            pubSignals[3], // sellerCommitment
            pubSignals[4], // threshold
            nullifier,
            block.timestamp
        );

        return true;
    }
}
