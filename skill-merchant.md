# Agora: Merchant Skill

> Accept private payments. Reward loyalty without tracking customers. No customer database. No PII. Just on-chain verification and stealth addresses.

## What Agora Gives You

- **Private payments**: Customers pay via the privacy relay to stealth addresses derived from your keys. You receive funds without knowing who sent them.
- **ZK loyalty proofs**: Customers prove they've spent above a threshold with you — without revealing their identity, transaction history, or specific amounts. You verify on-chain and apply discounts.
- **Deal discovery**: Publish your deals via your ERC-8004 agent card. Buyer agents discover you automatically.
- **No customer database**: You never store PII. No breach liability. The loyalty relationship is real and provable, but the customer holds the data.

## Privacy Relay

Buyers pay you through a privacy relay running inside a TEE. You don't need to interact with the relay directly — buyers call it, and it routes payments to your stealth addresses via the Railgun shielded pool. Your job is to publish your stealth meta-address and scan for incoming payments.

**Relay URL** (for reference / buyer agents): `https://7c8a9578d4e316b426d8ea3556e25e99e3c95bad-3100.dstack-pha-prod5.phala.network`

## Setup

### 1. Register on MerchantRegistry (Arbitrum)

Call `registerMerchant` on the MerchantRegistry contract:

```bash
# Using cast (foundry)
cast send 0xE876EeC58E79Db135d9E5Fd93E91aBf54eA4f583 \
  "registerMerchant(bytes32,string)" \
  0x<your-agent-id> \
  "Your Shop Name" \
  --rpc-url https://arb1.arbitrum.io/rpc \
  --private-key $MERCHANT_PRIVATE_KEY
```

Your `agentId` is a `bytes32` identifier from your ERC-8004 registration.

### 2. Generate Stealth Keys

Generate a spending/viewing key pair. The spending key controls funds. The viewing key lets you detect incoming payments without exposing the spending key.

```bash
# Generate stealth keys (any secp256k1 key generation tool works)
# You need two key pairs:
#   - Spending key pair: controls the funds at stealth addresses
#   - Viewing key pair: used to scan for payments addressed to you

# SAVE the private keys securely.
# PUBLISH the public keys (spendingPubKey, viewingPubKey) in your deal catalog.
```

The public keys form your **stealth meta-address**. Buyers (via the relay) derive one-time stealth addresses from this meta-address for each payment. You scan announcements with your viewing private key to detect which payments are yours.

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
      "endpoint": "https://raw.githubusercontent.com/vu1n/agora-protocol/main/skill-buyer.md"
    }
  ]
}
```

The `agora-skill` service points to the buyer skill doc. When a buyer agent discovers your card, it reads the skill doc and knows exactly how to pay you — no SDK needed, just HTTP calls to the relay. Include this so new buyers auto-discover how to transact.

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
- `price`: smallest unit (USDC has 6 decimals, so `5000000` = $5.00)
- `discountBps`: discount for loyalty-proven buyers (500 = 5%)
- `minLoyaltySpend`: minimum cumulative spend to qualify for discount (in smallest unit)
- `stealthMetaAddress`: your public stealth keys from step 2 — this is what the relay uses to derive payment addresses

## Receiving Payments

Buyers call `POST /pay` on the privacy relay with your `stealthMetaAddress`. The relay derives a one-time stealth address, routes the payment through Railgun, and submits it on-chain.

To detect payments, scan stealth address announcements using your **viewing private key**:

```
For each announcement on-chain:
  1. Take the ephemeral public key and view tag from the announcement
  2. Use your viewing private key to check if the announcement is addressed to you
  3. If it matches: the funds are at the derived stealth address
  4. Use your spending private key to derive the stealth private key and access the funds
```

You can scan announcements via any Arbitrum RPC endpoint by monitoring the stealth address announcement events. Only your viewing key can identify which payments belong to you.

## Issuing Receipts

After detecting a payment, issue a receipt to the buyer so they can build loyalty proofs later.

A receipt contains:
- **scopeCommitment**: hash of your merchant/category identifier
- **amount**: the payment amount
- **buyerCommitment**: derived from the stealth address (no identity revealed)
- **salt**: random value you generate
- **timestamp**: when the payment was detected

Send the receipt to the buyer off-chain (e.g., via the stealth address announcement channel or an encrypted message to the buyer's ephemeral identity). The buyer stores it locally and uses it as input to future ZK proofs.

Example receipt JSON:

```json
{
  "scopeCommitment": "0x...",
  "amount": "5000000",
  "buyerCommitment": "0x...",
  "salt": "0x...",
  "timestamp": 1711152000
}
```

## Updating Your Merkle Root

After issuing receipts, build a Merkle tree of all receipt leaves and publish the root on-chain. Buyers generate ZK proofs against this root.

```bash
# Update the purchase root on MerchantRegistry
cast send 0xE876EeC58E79Db135d9E5Fd93E91aBf54eA4f583 \
  "updatePurchaseRoot(bytes32,bytes32)" \
  0x<your-agent-id> \
  0x<new-merkle-root> \
  --rpc-url https://arb1.arbitrum.io/rpc \
  --private-key $MERCHANT_PRIVATE_KEY
```

Update the root periodically as new purchases come in. Buyers can only prove loyalty against receipts included in the current on-chain root.

## Verifying Loyalty Proofs

When a buyer includes a loyalty proof in their payment (via the relay), the on-chain `LoyaltyVerifier` contract validates it automatically. You can also verify proofs directly:

```bash
# Read verification result from LoyaltyManager
cast call 0xf66FB40f0ABD88Aa31dD88a2EfE65059143dB353 \
  "verifySpendProof(uint256[2],uint256[2][2],uint256[2],uint256[6],bytes32)" \
  "[a0,a1]" "[[b00,b01],[b10,b11]]" "[c0,c1]" "[s0,s1,s2,s3,s4,s5]" 0x<scope-id> \
  --rpc-url https://arb1.arbitrum.io/rpc
```

The proof reveals only that the buyer meets the spend threshold — not who they are or what they bought. If valid, apply the discount. The buyer pays the discounted price, and the proof is recorded on-chain with a nullifier to prevent replay.

## Discovering Buyer Intents

Buyer agents can post ephemeral intents via stealth-address-backed 8004 identities. Scan the 8004 registry for `agora-intent` services:

```json
{
  "category": "coffee",
  "maxPrice": 10000000,
  "loyaltyProofAvailable": true,
  "respondTo": "0x...stealth-address..."
}
```

Match against your inventory. Send deal offers to the buyer's `respondTo` stealth address. The buyer is completely anonymous — you're responding to a throwaway identity funded only for this transaction.

## Contract Addresses (Arbitrum)

```
LoyaltyVerifier:  0xF1Ea8695FEbfc104F095c093474ddC466EB67874
MerchantRegistry: 0xE876EeC58E79Db135d9E5Fd93E91aBf54eA4f583
LoyaltyManager:   0xf66FB40f0ABD88Aa31dD88a2EfE65059143dB353
```

## Architecture

```
Buyer Agent              Privacy Relay (TEE)              You (Merchant)
     |                        |                                |
     |                        |         Register on            |
     |                        |         MerchantRegistry ----->|
     |                        |         Publish deals via      |
     |                        |         8004 agent card ------>|
     |                        |         (includes skill-       |
     |                        |          buyer.md link)        |
     |                        |                                |
     |-- discover via 8004 ---|------------------------------->|
     |<- deals.json (with stealthMeta) -----------------------|
     |                        |                                |
     |-- POST /pay ---------->|                                |
     |   { token, amount,     |-- derive stealth addr         |
     |     merchantStealthMeta|-- route via Railgun            |
     |     loyaltyProof? }    |-- submit tx on-chain -------->|
     |                        |                                |
     |                        |       (scan announcements      |
     |                        |        with viewing key,       |
     |                        |        detect payment)         |
     |                        |                                |
     |<-- receipt (off-chain) ---------------------------------|
     |                        |                                |
     |                        |       Update Merkle root ----->|
     |                        |       on MerchantRegistry      |
     |                        |                                |
     |   You never learn the buyer's identity                  |
```
