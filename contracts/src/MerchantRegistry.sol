// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MerchantRegistry
/// @notice Maps ERC-8004 agent IDs to merchant configs and purchase Merkle roots.
///         Merchants update their root after adding purchase receipts to their tree.
contract MerchantRegistry {
    struct Merchant {
        address owner;
        bytes32 purchaseRoot;
        string name;
        uint256 registeredAt;
        bool active;
    }

    mapping(bytes32 => Merchant) public merchants;

    event MerchantRegistered(bytes32 indexed agentId, address owner, string name);
    event PurchaseRootUpdated(bytes32 indexed agentId, bytes32 oldRoot, bytes32 newRoot);

    modifier onlyMerchantOwner(bytes32 agentId) {
        require(merchants[agentId].owner == msg.sender, "not merchant owner");
        _;
    }

    function registerMerchant(bytes32 agentId, string calldata name) external {
        require(merchants[agentId].registeredAt == 0, "already registered");
        merchants[agentId] = Merchant({
            owner: msg.sender,
            purchaseRoot: bytes32(0),
            name: name,
            registeredAt: block.timestamp,
            active: true
        });
        emit MerchantRegistered(agentId, msg.sender, name);
    }

    function updatePurchaseRoot(bytes32 agentId, bytes32 newRoot) external onlyMerchantOwner(agentId) {
        require(merchants[agentId].active, "merchant not active");
        bytes32 oldRoot = merchants[agentId].purchaseRoot;
        merchants[agentId].purchaseRoot = newRoot;
        emit PurchaseRootUpdated(agentId, oldRoot, newRoot);
    }

    function getPurchaseRoot(bytes32 agentId) external view returns (bytes32) {
        return merchants[agentId].purchaseRoot;
    }

    function isRegistered(bytes32 agentId) external view returns (bool) {
        return merchants[agentId].registeredAt > 0;
    }
}
