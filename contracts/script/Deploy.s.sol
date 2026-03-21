// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Groth16Verifier} from "../src/LoyaltyVerifier.sol";
import {MerchantRegistry} from "../src/MerchantRegistry.sol";
import {LoyaltyManager} from "../src/LoyaltyManager.sol";

contract Deploy is Script {
    function run() external {
        vm.startBroadcast();

        Groth16Verifier verifier = new Groth16Verifier();
        console.log("LoyaltyVerifier:", address(verifier));

        MerchantRegistry registry = new MerchantRegistry();
        console.log("MerchantRegistry:", address(registry));

        LoyaltyManager manager = new LoyaltyManager(address(verifier), address(registry));
        console.log("LoyaltyManager:", address(manager));

        vm.stopBroadcast();
    }
}
