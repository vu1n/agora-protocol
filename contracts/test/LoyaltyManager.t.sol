// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {Groth16Verifier} from "../src/LoyaltyVerifier.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {LoyaltyManager} from "../src/LoyaltyManager.sol";

contract LoyaltyManagerTest is Test {
    Groth16Verifier verifier;
    MerchantRegistry registry;
    LoyaltyManager manager;

    address merchant = address(0xBEEF);
    bytes32 agentId = bytes32(uint256(1));

    // Real proof from smoke test (B-points swapped: snarkjs [real,imag] → EVM [imag,real])
    // Signal layout: [nullifier, merkleRoot, scopeCommitment, threshold, purchaseCount, minTimestamp]
    uint[2] proofA = [
        uint(9030755439504652402599665710493193982869954970121842720215969014940833450043),
        uint(20847453728342215397736716555225653603711270459382434974729135848228703606887)
    ];
    uint[2][2] proofB = [
        [
            uint(18982099037238852595783934092677999367364975847765878819277006132755306965604),
            uint(12499836000611942772828302992231005631174119351461938274233541320399119285000)
        ],
        [
            uint(20940259332403790150530907397889807449594095802560667373684333276839236589722),
            uint(21886482700338888683443655093599274987828301860024613688504562643633733692044)
        ]
    ];
    uint[2] proofC = [
        uint(18228022296970720089696553142690268597961580959452477479046746032749942750018),
        uint(13023475683249814631944305796602299172413119975872787986023519233519430248170)
    ];
    uint[6] pubSignals = [
        uint(19798605739564935073549250804389324169940709884357595324829624838663261287852),
        uint(4263751564619257984852810303718305543337895975530800773690493504323462145219),
        uint(12326503012965816391338144612242952408728683609716147019497703475006801258307),
        uint(500000000),
        uint(5),
        uint(0)
    ];

    function setUp() public {
        verifier = new Groth16Verifier();
        registry = new MerchantRegistry();
        manager = new LoyaltyManager(address(verifier), address(registry));

        vm.prank(merchant);
        registry.registerMerchant(agentId, "Test Merchant");

        vm.prank(merchant);
        registry.updatePurchaseRoot(agentId, bytes32(pubSignals[1]));
    }

    function test_merchantRegistration() public view {
        assertTrue(registry.isRegistered(agentId));
        assertEq(uint256(registry.getPurchaseRoot(agentId)), pubSignals[1]);
    }

    function test_verifyRealProof() public {
        bool result = manager.verifySpendProof(proofA, proofB, proofC, pubSignals, agentId);
        assertTrue(result);
        assertEq(manager.verificationCount(), 1);
    }

    function test_nullifierPreventsReplay() public {
        manager.verifySpendProof(proofA, proofB, proofC, pubSignals, agentId);
        vm.expectRevert(LoyaltyManager.NullifierAlreadyUsed.selector);
        manager.verifySpendProof(proofA, proofB, proofC, pubSignals, agentId);
    }

    function test_revertOnUnregisteredMerchant() public {
        bytes32 fakeId = bytes32(uint256(999));
        vm.expectRevert(LoyaltyManager.ScopeHasNoRoot.selector);
        manager.verifySpendProof(proofA, proofB, proofC, pubSignals, fakeId);
    }

    function test_revertOnRootMismatch() public {
        vm.prank(merchant);
        registry.updatePurchaseRoot(agentId, bytes32(uint256(12345)));
        vm.expectRevert(LoyaltyManager.RootMismatch.selector);
        manager.verifySpendProof(proofA, proofB, proofC, pubSignals, agentId);
    }

    function test_revertOnInvalidProof() public {
        uint[6] memory badSignals = pubSignals;
        badSignals[3] = 999; // wrong threshold
        vm.expectRevert(LoyaltyManager.InvalidProof.selector);
        manager.verifySpendProof(proofA, proofB, proofC, badSignals, agentId);
    }

    function test_onlyOwnerCanUpdateRoot() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("not merchant owner");
        registry.updatePurchaseRoot(agentId, bytes32(uint256(1)));
    }

    function test_deactivateMerchantClearsRoot() public {
        vm.prank(merchant);
        registry.deactivateMerchant(agentId);
        assertEq(uint256(registry.getPurchaseRoot(agentId)), 0);

        vm.expectRevert(LoyaltyManager.ScopeHasNoRoot.selector);
        manager.verifySpendProof(proofA, proofB, proofC, pubSignals, agentId);
    }

    function test_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit LoyaltyManager.SpendProofVerified(
            agentId,
            pubSignals[2],
            pubSignals[3],
            pubSignals[5],
            pubSignals[0],
            block.timestamp
        );
        manager.verifySpendProof(proofA, proofB, proofC, pubSignals, agentId);
    }
}
