# Agora: Buyer Skill

> One HTTP call for private payment. No SDK. No install. Just call the relay.

## What Agora Gives You

- **Private payments via relay**: POST one HTTP call to the privacy relay. It handles stealth addressing, Railgun shielding, and transaction submission inside a TEE. Your identity is never linked to the payment.
- **ZK loyalty rewards**: Prove you've spent enough to qualify for discounts — without revealing who you are, what you bought, or how much you spent.
- **Deal discovery**: Find merchant deals via their ERC-8004 agent cards. Evaluate them locally against your private spend history. No data leaves your agent.
- **Stealth intents**: Post "looking to buy X" from an ephemeral identity. Merchants match your intent. You stay anonymous.

## Privacy Relay

The relay runs inside a TEE (Trusted Execution Environment). It receives your payment request, constructs the stealth transfer through the Railgun shielded pool, and submits it on-chain. Your keys and payment details are never exposed outside the enclave.

**Relay URL**: `https://7c8a9578d4e316b426d8ea3556e25e99e3c95bad-3100.dstack-pha-prod5.phala.network`

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Check relay status |
| `GET` | `/attestation` | Verify TEE attestation before sending keys |
| `POST` | `/pay` | Private stealth payment |
| `POST` | `/shield` | Guidance for shielding funds into Railgun pool |

## Quick Start: Pay a Merchant

Two steps. Verify the relay is trustworthy, then pay.

### Step 1: Verify TEE Attestation

Before sending any sensitive data, confirm the relay is running inside a genuine TEE:

```bash
curl https://7c8a9578d4e316b426d8ea3556e25e99e3c95bad-3100.dstack-pha-prod5.phala.network/attestation
```

Inspect the response. It contains a remote attestation quote from the TEE hardware. Verify the quote against the expected enclave measurement to confirm the relay code has not been tampered with.

### Step 2: Make a Private Payment

```bash
curl -X POST https://7c8a9578d4e316b426d8ea3556e25e99e3c95bad-3100.dstack-pha-prod5.phala.network/pay \
  -H "Content-Type: application/json" \
  -d '{
    "token": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "amount": "5000000",
    "merchantStealthMeta": {
      "spendingPubKey": "0x04abc...",
      "viewingPubKey": "0x04def..."
    }
  }'
```

That's it. The relay derives a one-time stealth address from the merchant's keys, routes the payment through the Railgun shielded pool, and submits the transaction. The merchant detects the payment by scanning with their viewing key. Nobody can link you to the payment.

### Optional Fields on POST /pay

| Field | Type | Description |
|-------|------|-------------|
| `token` | `string` | Token contract address (e.g., USDC on Arbitrum) |
| `amount` | `string` | Amount in smallest unit (USDC 6 decimals: `"5000000"` = $5.00) |
| `merchantStealthMeta` | `object` | Merchant's `{ spendingPubKey, viewingPubKey }` from their deal catalog |
| `loyaltyProof` | `object` | ZK proof object if claiming a loyalty discount |
| `scopeId` | `string` | Merchant or category scope for loyalty verification |
| `fee` | `string` | Optional relay fee override |

### Shielding Funds

Before paying, your funds need to be in the Railgun shielded pool. Ask the relay for guidance:

```bash
curl -X POST https://7c8a9578d4e316b426d8ea3556e25e99e3c95bad-3100.dstack-pha-prod5.phala.network/shield \
  -H "Content-Type: application/json" \
  -d '{
    "token": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "amount": "100000000"
  }'
```

The response tells you how to deposit into the Railgun contract. Once shielded, your balance is private and ready for stealth payments via `/pay`.

## Discovering Deals

Merchants advertise via ERC-8004 agent cards. Query the 8004 registry for agents with `agora-deals` services:

```bash
# Fetch a merchant's deal catalog
curl https://coffee-shop.example/deals.json
```

Response:

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
  }
]
```

Use the `stealthMetaAddress` from the deal as the `merchantStealthMeta` in your `/pay` call. If the deal has a `discountBps` and you qualify, include your `loyaltyProof` and `scopeId`.

## Storing Receipts

After payment, the merchant issues a receipt off-chain. Store it locally in your agent. Receipts are the raw material for ZK loyalty proofs. They never leave your agent.

A receipt contains: scope commitment, amount, buyer commitment, salt, and timestamp.

## ZK Loyalty Proofs

When a merchant offers a loyalty discount (e.g., "5% off for buyers who've spent $50+"), you prove you qualify without revealing your identity.

### How It Works

1. You accumulate receipts locally from purchases with a merchant (or across a category).
2. You generate a ZK proof that your total spend meets the threshold.
3. You include the proof in your `/pay` call. The relay submits it on-chain for verification.

You can generate proofs locally if you have a compatible prover, or present raw receipts to a trusted proving service. The proof proves `spend >= threshold` without revealing your identity, specific amounts, or transaction history.

### What the Proof Reveals

- Your spend meets the threshold (boolean: yes/no)
- The merchant's scope commitment
- The threshold amount
- A nullifier (prevents replay)

### What the Proof Does NOT Reveal

- Your identity
- Your specific purchase amounts
- Your transaction history
- How much above the threshold you are

### Including a Loyalty Proof in Payment

```bash
curl -X POST https://7c8a9578d4e316b426d8ea3556e25e99e3c95bad-3100.dstack-pha-prod5.phala.network/pay \
  -H "Content-Type: application/json" \
  -d '{
    "token": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "amount": "4750000",
    "merchantStealthMeta": {
      "spendingPubKey": "0x04abc...",
      "viewingPubKey": "0x04def..."
    },
    "loyaltyProof": {
      "a": ["0x...", "0x..."],
      "b": [["0x...", "0x..."], ["0x...", "0x..."]],
      "c": ["0x...", "0x..."],
      "pubSignals": ["0x...", "0x...", "0x...", "0x...", "0x...", "0x..."]
    },
    "scopeId": "0x..."
  }'
```

The relay submits the payment and the loyalty proof together. The on-chain `LoyaltyVerifier` confirms the proof is valid. The merchant sees you paid the discounted price and that a valid proof was submitted — but never learns who you are.

## Posting Stealth Intents

Want to find merchants without revealing your identity? Post an intent from an ephemeral stealth identity.

### 1. Create a Throwaway Identity

Generate a stealth key pair. Derive a stealth address. Fund it via the Railgun shielded pool (unlinkable to your main identity). Only fund what you're willing to spend — this is your spending cap.

### 2. Register a Throwaway 8004 Identity

Register from the stealth address on the 8004 registry:

```json
{
  "metadata": {
    "type": "agent",
    "name": "anonymous-buyer",
    "description": "Looking for coffee deals via Agora"
  },
  "services": [
    {
      "type": "agora-intent",
      "endpoint": "https://ephemeral-host.example/intent.json"
    }
  ]
}
```

### 3. Publish Your Intent

```json
{
  "category": "coffee",
  "maxPrice": 10000000,
  "loyaltyProofAvailable": true,
  "respondTo": "0x...stealth-address..."
}
```

### 4. Merchants Respond

Merchants scan for `agora-intent` services, match your category, and send deal offers to your stealth address. You evaluate them locally and pay via the relay — all from the ephemeral identity.

After the transaction, abandon the stealth identity. The merchant never learns your real identity. The receipt goes into your private local storage under your real buyer secret.

## Privacy Summary

| Action | What's revealed | What's hidden |
|--------|----------------|---------------|
| Discovering deals | You queried a public endpoint | Your identity |
| Making payment | A stealth address paid a stealth address | Who paid, who received |
| Proving loyalty | Spend >= threshold (boolean) | Identity, amounts, history |
| Posting intent | "Someone wants coffee" | Who wants it |
| Receiving receipt | A purchase happened | Who the buyer is |

## Contract Addresses (Arbitrum)

```
LoyaltyVerifier:  0xF1Ea8695FEbfc104F095c093474ddC466EB67874
MerchantRegistry: 0xE876EeC58E79Db135d9E5Fd93E91aBf54eA4f583
LoyaltyManager:   0xf66FB40f0ABD88Aa31dD88a2EfE65059143dB353
```

## Architecture

```
You (Buyer Agent)                       Privacy Relay (TEE)              Merchant Agent
     |                                       |                                |
     |-- GET /attestation ------------------>|                                |
     |<-- TEE quote -------------------------|                                |
     |   (verify enclave measurement)        |                                |
     |                                       |                                |
     |-- Discover via 8004 registry -------->|                                |
     |-- Fetch deals.json -------------------------------------------------->|
     |<-- deal catalog (with stealthMeta) -----------------------------------|
     |                                       |                                |
     |-- POST /pay { token, amount,          |                                |
     |     merchantStealthMeta,              |                                |
     |     loyaltyProof? } ----------------->|                                |
     |                                       |-- derive stealth addr          |
     |                                       |-- route via Railgun            |
     |                                       |-- submit tx on-chain --------->|
     |<-- tx confirmation -------------------|                                |
     |                                       |                                |
     |                                       |    (merchant scans with        |
     |                                       |     viewing key, detects       |
     |                                       |     payment)                   |
     |<-- receipt (off-chain) --------------------------------------------|
     |   Store receipt locally               |                                |
     |                                       |                                |
     |   Your identity is never revealed     |                                |
```
