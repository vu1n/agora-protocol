// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MerchantRegistry
/// @notice Maps ERC-8004 agent IDs to merchant configs, Merkle roots, and EdDSA public keys.
contract MerchantRegistry {
    struct Merchant {
        address owner;
        bytes32 purchaseRoot;
        uint256 eddsaAx;      // Baby Jubjub EdDSA public key x-coordinate
        uint256 eddsaAy;      // Baby Jubjub EdDSA public key y-coordinate
        string name;
        uint256 registeredAt;
        bool active;
    }

    mapping(bytes32 => Merchant) public merchants;

    event MerchantRegistered(bytes32 indexed agentId, address owner, string name, uint256 eddsaAx, uint256 eddsaAy);
    event PurchaseRootUpdated(bytes32 indexed agentId, bytes32 oldRoot, bytes32 newRoot);

    modifier onlyMerchantOwner(bytes32 agentId) {
        require(merchants[agentId].owner == msg.sender, "not merchant owner");
        _;
    }

    function registerMerchant(
        bytes32 agentId,
        string calldata name,
        uint256 eddsaAx,
        uint256 eddsaAy
    ) external {
        require(merchants[agentId].registeredAt == 0, "already registered");
        merchants[agentId] = Merchant({
            owner: msg.sender,
            purchaseRoot: bytes32(0),
            eddsaAx: eddsaAx,
            eddsaAy: eddsaAy,
            name: name,
            registeredAt: block.timestamp,
            active: true
        });
        emit MerchantRegistered(agentId, msg.sender, name, eddsaAx, eddsaAy);
    }

    function updatePurchaseRoot(bytes32 agentId, bytes32 newRoot) external onlyMerchantOwner(agentId) {
        require(merchants[agentId].active, "merchant not active");
        bytes32 oldRoot = merchants[agentId].purchaseRoot;
        merchants[agentId].purchaseRoot = newRoot;
        emit PurchaseRootUpdated(agentId, oldRoot, newRoot);
    }

    function deactivateMerchant(bytes32 agentId) external onlyMerchantOwner(agentId) {
        merchants[agentId].active = false;
        merchants[agentId].purchaseRoot = bytes32(0);
    }

    function getPurchaseRoot(bytes32 agentId) external view returns (bytes32) {
        return merchants[agentId].purchaseRoot;
    }

    function getEdDSAKey(bytes32 agentId) external view returns (uint256 ax, uint256 ay) {
        return (merchants[agentId].eddsaAx, merchants[agentId].eddsaAy);
    }

    function isRegistered(bytes32 agentId) external view returns (bool) {
        return merchants[agentId].registeredAt > 0;
    }
}
