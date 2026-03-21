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

    // Real proof from circuit smoke test
    uint[2] proofA = [
        uint(12111067958261098890682094627159412013336861179940363509010175172333752621386),
        uint(21586434824508663208561215692329057338675822845414377087376719793672779959585)
    ];
    // B-point coordinates swapped: snarkjs JSON is [real, imag] but EVM expects [imag, real]
    uint[2][2] proofB = [
        [
            uint(13730787600701843575676278005349736604108355763131123306926757288776709388710),
            uint(5107059405816380812360679183956140004744781955022724717085507287100935016444)
        ],
        [
            uint(7186057461167494152997863840033022277940263970507549666144095352033655536023),
            uint(8707000773614017978421982453020888906354651168986923184416855717788549854255)
        ]
    ];
    uint[2] proofC = [
        uint(16320628061332370861777698664078652297225191344444125254336314842595098012604),
        uint(12039662341641018195436686131977691399846325362485487718863656429131004611048)
    ];

    // Public signals: [nullifier, valid, merkleRoot, sellerCommitment, threshold, purchaseCount]
    uint[6] pubSignals = [
        uint(9695823638246474546538215023262160681571740342650551079805894579820670686570),
        uint(1),
        uint(20748791184647381062233815425181152485417712308398577677610981673397650128489),
        uint(12326503012965816391338144612242952408728683609716147019497703475006801258307),
        uint(500000000),
        uint(5)
    ];

    function setUp() public {
        verifier = new Groth16Verifier();
        registry = new MerchantRegistry();
        manager = new LoyaltyManager(address(verifier), address(registry));

        // Register merchant and set their purchase root
        vm.prank(merchant);
        registry.registerMerchant(agentId, "Test Merchant");

        // Set the Merkle root to match the proof's root
        vm.prank(merchant);
        registry.updatePurchaseRoot(agentId, bytes32(pubSignals[2]));
    }

    function test_merchantRegistration() public view {
        assertTrue(registry.isRegistered(agentId));
        assertEq(uint256(registry.getPurchaseRoot(agentId)), pubSignals[2]);
    }

    function test_verifyRealProof() public {
        bool result = manager.verifyLoyaltyFull(proofA, proofB, proofC, pubSignals, agentId);
        assertTrue(result);
        assertEq(manager.verificationCount(), 1);
    }

    function test_nullifierPreventsReplay() public {
        manager.verifyLoyaltyFull(proofA, proofB, proofC, pubSignals, agentId);

        vm.expectRevert(LoyaltyManager.NullifierAlreadyUsed.selector);
        manager.verifyLoyaltyFull(proofA, proofB, proofC, pubSignals, agentId);
    }

    function test_revertOnUnregisteredMerchant() public {
        bytes32 fakeAgentId = bytes32(uint256(999));
        vm.expectRevert(LoyaltyManager.MerchantHasNoRoot.selector);
        manager.verifyLoyaltyFull(proofA, proofB, proofC, pubSignals, fakeAgentId);
    }

    function test_revertOnRootMismatch() public {
        // Change the root in registry so it doesn't match the proof
        vm.prank(merchant);
        registry.updatePurchaseRoot(agentId, bytes32(uint256(12345)));

        vm.expectRevert(LoyaltyManager.RootMismatch.selector);
        manager.verifyLoyaltyFull(proofA, proofB, proofC, pubSignals, agentId);
    }

    function test_revertOnInvalidProof() public {
        // Tamper with a public signal
        uint[6] memory badSignals = pubSignals;
        badSignals[4] = 999; // wrong threshold
        vm.expectRevert(LoyaltyManager.InvalidProof.selector);
        manager.verifyLoyaltyFull(proofA, proofB, proofC, badSignals, agentId);
    }

    function test_onlyOwnerCanUpdateRoot() public {
        vm.prank(address(0xDEAD));
        vm.expectRevert("not merchant owner");
        registry.updatePurchaseRoot(agentId, bytes32(uint256(1)));
    }

    function test_emitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit LoyaltyManager.LoyaltyProofVerified(
            agentId,
            pubSignals[3],
            pubSignals[4],
            pubSignals[0],
            block.timestamp
        );
        manager.verifyLoyaltyFull(proofA, proofB, proofC, pubSignals, agentId);
    }
}
