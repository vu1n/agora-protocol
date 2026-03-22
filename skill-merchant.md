# Agora: Merchant Skill

> Accept private payments. Reward loyalty without tracking customers. Reach buyers who want what you sell.

## What Agora Gives You

- **Private payments**: Customers pay via stealth addresses. You receive funds without knowing who sent them.
- **ZK loyalty proofs**: Customers prove they've spent above a threshold with you — without revealing their identity, transaction history, or specific amounts. You verify on-chain and apply discounts.
- **Deal discovery**: Publish your deals via your ERC-8004 agent card. Buyer agents discover you automatically.
- **No customer database**: You never store PII. No breach liability. The loyalty relationship is real and provable, but the customer holds the data.

## Install

```bash
npm install agora-protocol
# or
bun add agora-protocol
```

## Setup

### 1. Register on MerchantRegistry

```typescript
import { createWalletClient, http, parseAbi } from "viem";
import { arbitrum } from "viem/chains";

const registryAbi = parseAbi([
  "function registerMerchant(bytes32 agentId, string name) external",
  "function updatePurchaseRoot(bytes32 agentId, bytes32 newRoot) external",
]);

// Your ERC-8004 agent ID (from your 8004 registration)
const AGENT_ID = "0x..."; // bytes32

await walletClient.writeContract({
  address: AGORA_REGISTRY,
  abi: registryAbi,
  functionName: "registerMerchant",
  args: [AGENT_ID, "Your Shop Name"],
});
```

### 2. Generate Stealth Keys

```typescript
import { generateStealthKeys } from "agora-protocol/sdk";

const { spendingPrivKey, viewingPrivKey, meta } = generateStealthKeys();

// SAVE spendingPrivKey and viewingPrivKey securely.
// PUBLISH meta (public keys) in your 8004 agent card and deal catalog.
```

### 3. Configure Your ERC-8004 Agent Card

Update your `agentURI` registration file:

```json
{
  "metadata": {
    "type": "agent",
    "name": "Your Shop Name",
    "description": "Accepts private payments via Agora. Loyalty rewards available."
  },
  "services": [
    {
      "type": "agora-deals",
      "endpoint": "https://your-shop.example/deals.json"
    },
    {
      "type": "agora-skill",
      "endpoint": "https://github.com/vu1n/agora-protocol/blob/main/skill-buyer.md"
    }
  ]
}
```

The `agora-skill` service tells buyer agents how to interact with you. Include it so new buyers can onboard automatically.

### 4. Publish Your Deal Catalog

Host a JSON file at your `agora-deals` endpoint:

```json
[
  {
    "item": "Espresso",
    "category": "coffee",
    "price": 5000000,
    "currency": "USDC",
    "discountBps": 500,
    "minLoyaltySpend": 50000000,
    "stealthMetaAddress": {
      "spendingPubKey": "0x04abc...",
      "viewingPubKey": "0x04def..."
    }
  },
  {
    "item": "Latte",
    "category": "coffee",
    "price": 7000000,
    "currency": "USDC",
    "discountBps": 500,
    "minLoyaltySpend": 50000000,
    "stealthMetaAddress": {
      "spendingPubKey": "0x04abc...",
      "viewingPubKey": "0x04def..."
    }
  }
]
```

Fields:
- `price`: smallest unit (USDC has 6 decimals, so 5000000 = $5.00)
- `discountBps`: discount for loyalty-proven buyers (500 = 5%)
- `minLoyaltySpend`: minimum cumulative spend to qualify for discount
- `stealthMetaAddress`: your public stealth keys (from step 2)

## Receiving Payments

Buyers pay to one-time stealth addresses derived from your meta-address. To detect payments, scan for stealth address announcements:

```typescript
import { checkStealthAddress } from "agora-protocol/sdk";

// For each announcement on-chain:
const result = checkStealthAddress(
  announcement.ephemeralPubKey,
  announcement.viewTag,
  viewingPrivKey,    // your private viewing key
  meta.spendingPubKey, // your public spending key
);

if (result.match) {
  console.log("Payment received at:", result.stealthAddress);
  // Funds are at this address. Use spendingPrivKey to derive the stealth private key.
}
```

## Issuing Receipts

After detecting a payment, issue a receipt so the buyer can prove loyalty later:

```typescript
import { AgoraProver } from "agora-protocol";

const prover = new AgoraProver();
await prover.init();

const scopeCommitment = prover.hash(YOUR_SELLER_ID);
const receipt = prover.createReceipt(
  scopeCommitment,
  paymentAmount,
  buyerCommitment, // from the buyer's proof or the stealth address derivation
  randomSalt,
  BigInt(Math.floor(Date.now() / 1000)),
);

// Send receipt to buyer (off-chain, encrypted, or via the stealth address announcement)
```

## Updating Your Purchase Root

After issuing receipts, add them to your Merkle tree and publish the root on-chain:

```typescript
// Build tree from all receipts you've issued
// (the prover handles this internally — you just need to track receipt leaves)

await walletClient.writeContract({
  address: AGORA_REGISTRY,
  abi: registryAbi,
  functionName: "updatePurchaseRoot",
  args: [AGENT_ID, newMerkleRoot],
});
```

Buyers generate ZK proofs against this root. Update it periodically as new purchases come in.

## Verifying Loyalty Proofs

When a buyer presents a loyalty proof at checkout:

```typescript
const managerAbi = parseAbi([
  "function verifySpendProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[6] pubSignals, bytes32 scopeId) external returns (bool)",
]);

// The buyer submits the proof. Your contract verifies it.
// If valid: apply the discount. The proof reveals only that the buyer
// meets the spend threshold — not who they are or what they bought.
```

## Discovering Buyer Intents

Buyer agents can post ephemeral intents via stealth-address-backed 8004 identities:

```json
{
  "services": [
    {
      "type": "agora-intent",
      "endpoint": "https://ephemeral.example/intents.json"
    }
  ]
}
```

Scan the 8004 registry for `agora-intent` services. Match against your inventory. Respond to the stealth address. The buyer is completely anonymous — you're responding to a throwaway identity funded only for this transaction.

## Contract Addresses (Arbitrum)

```
LoyaltyVerifier:  0xF1Ea8695FEbfc104F095c093474ddC466EB67874 (Arbitrum)
MerchantRegistry: 0xE876EeC58E79Db135d9E5Fd93E91aBf54eA4f583 (Arbitrum)
LoyaltyManager:   0xf66FB40f0ABD88Aa31dD88a2EfE65059143dB353 (Arbitrum)
```

## Architecture

```
You (Merchant)                          Buyer Agent
     │                                       │
     ├─ Register on MerchantRegistry         │
     ├─ Publish deals via 8004 agent card    │
     ├─ Include skill-buyer.md link          │
     │                                       │
     │         ◄── discovers you via 8004 ───┤
     │         ◄── fetches deals.json ───────┤
     │                                       │
     │         ◄── stealth payment ──────────┤  (you can't see who paid)
     │                                       │
     ├─ Detect payment (scan announcements)  │
     ├─ Issue receipt ──────────────────────▶│  (buyer stores privately)
     ├─ Update Merkle root on-chain          │
     │                                       │
     │         ◄── ZK loyalty proof ─────────┤  (proves spend ≥ threshold)
     │                                       │
     ├─ Verify on-chain                      │
     ├─ Apply discount                       │
     │                                       │
     │  You never learn the buyer's identity │
```
