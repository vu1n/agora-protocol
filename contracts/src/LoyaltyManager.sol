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
/// @notice Verifies ZK spend proofs on-chain. Supports per-merchant loyalty
///         and cross-merchant category LTV, with optional time bounds.
///         The Merkle root is cross-checked against MerchantRegistry.
///
/// Public signals layout:
///   [0] nullifier          (circuit output)
///   [1] merkleRoot         (cross-checked vs registry)
///   [2] scopeCommitment    (merchant or category hash)
///   [3] threshold           (minimum spend proven)
///   [4] purchaseCount
///   [5] minTimestamp        (0 = all-time)
contract LoyaltyManager {
    IGroth16Verifier public immutable verifier;
    MerchantRegistry public immutable registry;

    mapping(uint256 => bool) public usedNullifiers;
    uint256 public verificationCount;

    event SpendProofVerified(
        bytes32 indexed scopeId,
        uint256 scopeCommitment,
        uint256 threshold,
        uint256 minTimestamp,
        uint256 nullifier,
        uint256 timestamp
    );

    error InvalidProof();
    error NullifierAlreadyUsed();
    error ScopeHasNoRoot();
    error RootMismatch();

    constructor(address _verifier, address _registry) {
        verifier = IGroth16Verifier(_verifier);
        registry = MerchantRegistry(_registry);
    }

    /// @param pubSignals [nullifier, merkleRoot, scopeCommitment, threshold, purchaseCount, minTimestamp]
    /// @param scopeId Agent ID (merchant) or category ID — used to look up root from registry
    function verifySpendProof(
        uint[2] calldata a,
        uint[2][2] calldata b,
        uint[2] calldata c,
        uint[6] calldata pubSignals,
        bytes32 scopeId
    ) external returns (bool) {
        uint256 nullifier = pubSignals[0];
        uint256 proofRoot = pubSignals[1];

        // Cross-check root against registry
        bytes32 registryRoot = registry.getPurchaseRoot(scopeId);
        if (registryRoot == bytes32(0)) revert ScopeHasNoRoot();
        if (uint256(registryRoot) != proofRoot) revert RootMismatch();

        // Check nullifier not used
        if (usedNullifiers[nullifier]) revert NullifierAlreadyUsed();

        // Verify Groth16 proof
        if (!verifier.verifyProof(a, b, c, pubSignals)) revert InvalidProof();

        // Mark nullifier used
        usedNullifiers[nullifier] = true;
        verificationCount++;

        emit SpendProofVerified(
            scopeId,
            pubSignals[2],
            pubSignals[3],
            pubSignals[5],
            nullifier,
            block.timestamp
        );

        return true;
    }
}
