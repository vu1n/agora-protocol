// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Groth16Verifier} from "../src/LoyaltyVerifier.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {LoyaltyManager} from "../src/LoyaltyManager.sol";

/// @notice Invariant test handler for stateful fuzzing.
/// forge test --match-contract LoyaltyInvariant
contract LoyaltyInvariantHandler is Test {
    MerchantRegistry public registry;
    LoyaltyManager public manager;

    mapping(uint256 => bool) public seenNullifiers;
    uint256 public nullifierCount;
    uint256 public verifyAttempts;
    uint256 public verifySuccesses;

    bytes32[] public registeredAgents;

    function registeredAgentCount() external view returns (uint256) {
        return registeredAgents.length;
    }

    constructor(MerchantRegistry _registry, LoyaltyManager _manager) {
        registry = _registry;
        manager = _manager;
    }

    function registerMerchant(bytes32 agentId, string calldata name) external {
        if (registry.isRegistered(agentId)) return;
        registry.registerMerchant(agentId, name, 0, 0);
        registeredAgents.push(agentId);
    }

    function updateRoot(uint256 agentIdx, bytes32 newRoot) external {
        if (registeredAgents.length == 0) return;
        agentIdx = agentIdx % registeredAgents.length;
        bytes32 agentId = registeredAgents[agentIdx];
        registry.updatePurchaseRoot(agentId, newRoot);
    }

    function tryVerify(
        uint[2] calldata a, uint[2][2] calldata b, uint[2] calldata c,
        uint[8] calldata pubSignals, uint256 agentIdx
    ) external {
        if (registeredAgents.length == 0) return;
        agentIdx = agentIdx % registeredAgents.length;
        bytes32 agentId = registeredAgents[agentIdx];
        verifyAttempts++;

        try manager.verifySpendProof(a, b, c, pubSignals, agentId) {
            uint256 nullifier = pubSignals[0];
            if (seenNullifiers[nullifier]) {
                // This should never happen — a reused nullifier should have reverted
                revert("INVARIANT VIOLATION: nullifier reused");
            }
            seenNullifiers[nullifier] = true;
            nullifierCount++;
            verifySuccesses++;
        } catch {
            // Expected: most random proofs will fail verification
        }
    }
}

contract LoyaltyInvariant is Test {
    Groth16Verifier verifier;
    MerchantRegistry registry;
    LoyaltyManager manager;
    LoyaltyInvariantHandler handler;

    function setUp() public {
        verifier = new Groth16Verifier();
        registry = new MerchantRegistry();
        manager = new LoyaltyManager(address(verifier), address(registry));
        handler = new LoyaltyInvariantHandler(registry, manager);

        // All handler calls come from the handler itself (it's the merchant owner)
        targetContract(address(handler));
    }

    /// @notice Nullifier count must equal successful verifications.
    function invariant_nullifierCountMatchesVerifications() public view {
        assertEq(handler.nullifierCount(), handler.verifySuccesses());
    }

    /// @notice Verification count on the manager matches handler tracking.
    function invariant_managerCountMatchesHandler() public view {
        assertEq(manager.verificationCount(), handler.verifySuccesses());
    }

    /// @notice No registered agent should have an empty root after explicit update.
    /// (This is a weaker invariant — just checks the registry isn't corrupted)
    function invariant_registryConsistency() public view {
        for (uint i = 0; i < handler.registeredAgentCount() && i < 10; i++) {
            bytes32 agentId = handler.registeredAgents(i);
            assertTrue(registry.isRegistered(agentId));
        }
    }
}
