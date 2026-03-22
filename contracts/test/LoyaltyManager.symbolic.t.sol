// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Groth16Verifier} from "../src/LoyaltyVerifier.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {LoyaltyManager} from "../src/LoyaltyManager.sol";

/// @notice Halmos symbolic tests for critical properties.
/// Run with: halmos --contract LoyaltyManagerSymbolic
contract LoyaltyManagerSymbolic is Test {
    Groth16Verifier verifier;
    MerchantRegistry registry;
    LoyaltyManager manager;

    address merchant = address(0xBEEF);
    bytes32 agentId = bytes32(uint256(1));

    function setUp() public {
        verifier = new Groth16Verifier();
        registry = new MerchantRegistry();
        manager = new LoyaltyManager(address(verifier), address(registry));

        vm.prank(merchant);
        registry.registerMerchant(agentId, "Test");
    }

    /// @notice A nullifier can never be used twice.
    /// Halmos explores all possible proof inputs symbolically.
    function check_nullifierNeverReusable(
        uint[2] calldata a1, uint[2][2] calldata b1, uint[2] calldata c1, uint[6] calldata pub1,
        uint[2] calldata a2, uint[2][2] calldata b2, uint[2] calldata c2, uint[6] calldata pub2
    ) public {
        // Set root to match first proof's claimed root
        vm.prank(merchant);
        registry.updatePurchaseRoot(agentId, bytes32(pub1[1]));

        // First verification succeeds (if proof is valid)
        try manager.verifySpendProof(a1, b1, c1, pub1, agentId) {} catch { return; }

        // If same nullifier, second must fail
        if (pub2[0] == pub1[0]) {
            // Set root for second proof
            vm.prank(merchant);
            registry.updatePurchaseRoot(agentId, bytes32(pub2[1]));

            try manager.verifySpendProof(a2, b2, c2, pub2, agentId) {
                // If we reach here with the same nullifier, that's a bug
                assert(false); // "nullifier reuse should be impossible"
            } catch {
                // Expected: reverts with NullifierAlreadyUsed
            }
        }
    }

    /// @notice Unregistered scope always reverts.
    function check_unregisteredScopeAlwaysReverts(
        uint[2] calldata a, uint[2][2] calldata b, uint[2] calldata c,
        uint[6] calldata pub, bytes32 scopeId
    ) public {
        // scopeId that was never registered
        vm.assume(scopeId != agentId);
        vm.assume(!registry.isRegistered(scopeId));

        try manager.verifySpendProof(a, b, c, pub, scopeId) {
            assert(false); // "should have reverted for unregistered scope"
        } catch {}
    }

    /// @notice Root mismatch always reverts.
    function check_rootMismatchAlwaysReverts(
        uint[2] calldata a, uint[2][2] calldata b, uint[2] calldata c,
        uint[6] calldata pub, bytes32 fakeRoot
    ) public {
        vm.prank(merchant);
        registry.updatePurchaseRoot(agentId, fakeRoot);

        // If the proof's root doesn't match the registry root, it must revert
        vm.assume(uint256(fakeRoot) != pub[1]);
        vm.assume(fakeRoot != bytes32(0));

        try manager.verifySpendProof(a, b, c, pub, agentId) {
            assert(false); // "should have reverted for root mismatch"
        } catch {}
    }

    /// @notice Deactivated merchant always reverts (root is cleared).
    function check_deactivatedMerchantReverts(
        uint[2] calldata a, uint[2][2] calldata b, uint[2] calldata c,
        uint[6] calldata pub
    ) public {
        vm.prank(merchant);
        registry.updatePurchaseRoot(agentId, bytes32(pub[1]));

        vm.prank(merchant);
        registry.deactivateMerchant(agentId);

        try manager.verifySpendProof(a, b, c, pub, agentId) {
            assert(false); // "should have reverted for deactivated merchant"
        } catch {}
    }

    /// @notice Verification count increments exactly once per successful verification.
    function check_verificationCountIncrements(
        uint[2] calldata a, uint[2][2] calldata b, uint[2] calldata c,
        uint[6] calldata pub
    ) public {
        vm.prank(merchant);
        registry.updatePurchaseRoot(agentId, bytes32(pub[1]));

        uint256 countBefore = manager.verificationCount();

        try manager.verifySpendProof(a, b, c, pub, agentId) {
            assertEq(manager.verificationCount(), countBefore + 1);
        } catch {
            assertEq(manager.verificationCount(), countBefore);
        }
    }

    /// @notice Only merchant owner can update root.
    function check_onlyOwnerUpdatesRoot(address caller, bytes32 newRoot) public {
        vm.assume(caller != merchant);
        vm.assume(caller != address(0));

        vm.prank(caller);
        try registry.updatePurchaseRoot(agentId, newRoot) {
            assert(false); // "non-owner should not be able to update root"
        } catch {}
    }
}
