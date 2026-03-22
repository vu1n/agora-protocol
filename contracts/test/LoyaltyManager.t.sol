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

    // Real proof from EdDSA-signed circuit (B-points swapped for EVM)
    // Signal layout: [nullifier, merkleRoot, scopeCommitment, threshold, purchaseCount, minTimestamp, merchantAx, merchantAy]
    uint[2] proofA = [
        uint(8629305173853832421022621273396086468330640090475850410257278613656568916381),
        uint(1411955665457424580527456254328611816048734264811850026432057924437029535939)
    ];
    uint[2][2] proofB = [
        [
            uint(5240888043695931271242094991523718133789518412105183028636155248039174219874),
            uint(8315116568732945660362123924081752911029643617177495925332842560553454385607)
        ],
        [
            uint(14907570230246927259293363909587369296667009466807096963026570938344957403228),
            uint(3398972338412069632085126461759761881777418362467644016245633891240609804580)
        ]
    ];
    uint[2] proofC = [
        uint(8051679376753101971877558253723583702368107645310556534975522746108222301691),
        uint(11425567926921864917346199842772086182765354763637226312444407640333728112683)
    ];
    uint[8] pubSignals = [
        uint(3647166768557714489702767600517158359579528912320649100921909138063368498971),
        uint(17450228805589279898136229395966240918885085017781064268073731449475971339626),
        uint(12326503012965816391338144612242952408728683609716147019497703475006801258307),
        uint(500000000),
        uint(5),
        uint(0),
        uint(2323089994540402667436267813647615201872748351902172515524901997531212743295),
        uint(12317655903656189808902108314292684613443996443978066123499327472477140971830)
    ];

    function setUp() public {
        verifier = new Groth16Verifier();
        registry = new MerchantRegistry();
        manager = new LoyaltyManager(address(verifier), address(registry));

        vm.prank(merchant);
        registry.registerMerchant(agentId, "Test Merchant", pubSignals[6], pubSignals[7]);

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
        uint[8] memory badSignals = pubSignals;
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
