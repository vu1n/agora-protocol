# Agora: Buyer Skill

> Pay privately. Prove loyalty without revealing identity. Find deals from merchants who respect your privacy.

## What Agora Gives You

- **Private payments**: Pay merchants via stealth addresses. Your identity is never linked to the transaction.
- **ZK loyalty rewards**: Prove you've spent enough to qualify for discounts — without revealing who you are, what you bought, or how much you spent.
- **Deal discovery**: Find merchant deals via their ERC-8004 agent cards. Evaluate them locally against your private spend history. No data leaves your agent.
- **Stealth intents**: Post "looking to buy X" from an ephemeral identity. Merchants match your intent. You stay anonymous.

## Install

```bash
npm install agora-protocol
# or
bun add agora-protocol
```

## Quick Start

```typescript
import { AgoraProver, ProofCache } from "agora-protocol";
import { DealDiscovery, generateStealthKeys, deriveStealthAddress, planAgoraRecipe } from "agora-protocol/sdk";

// Initialize
const prover = new AgoraProver();
await prover.init();

const BUYER_SECRET = /* your private key — never shared */;
const buyerCommitment = prover.hash(BUYER_SECRET);
```

## Discovering Deals

Merchants advertise via ERC-8004 agent cards. Query the 8004 registry for agents with `agora-deals` services:

```typescript
const discovery = new DealDiscovery();

// Fetch deals from known merchants (agentURI from 8004 registry)
const deals = await discovery.discoverDeals([
  { agentURI: "https://coffee-shop.example/agent.json", agentId: "agent-123" },
  { agentURI: "https://bakery.example/agent.json", agentId: "agent-456" },
], { category: "coffee" });

// Evaluate deals against your private spend history — runs locally, no data shared
for (const deal of deals) {
  const mySpend = /* sum of your receipts for this merchant/category */;
  const eval = discovery.evaluateDeal(deal, mySpend);
  console.log(`${deal.item}: $${Number(eval.effectivePrice) / 1e6}`);
  if (eval.qualifies) console.log(`  You save $${Number(eval.savings) / 1e6} with loyalty!`);
}
```

## Making Private Payments

When you find a deal you want, pay via stealth address:

```typescript
import { deriveStealthAddress } from "agora-protocol/sdk";

// Derive a one-time stealth address from the merchant's meta-address
const stealth = deriveStealthAddress(deal.stealthMeta);

// Send payment to the stealth address
// In production: fund from Railgun shielded pool (breaks the on-chain link)
// The merchant detects the payment by scanning announcements with their viewing key
```

### Full Recipe (Payment + Loyalty Proof)

```typescript
import { planAgoraRecipe } from "agora-protocol/sdk";

const result = planAgoraRecipe(
  {
    token: USDC_ADDRESS,
    amount: deal.price,
    merchantMeta: deal.stealthMeta,
    scopeId: MERCHANT_AGENT_ID,
    currentMerchantRoot: /* read from MerchantRegistry on-chain */,
    loyaltyProof: await cache.getProof(merchantId, scopeCommitment, deal.minLoyaltySpend),
  },
  agoraConfig,
  prover,
);

// result.plan contains typed call intents:
//   1. ERC20 transfer to stealth address (payment)
//   2. verifySpendProof on LoyaltyManager (loyalty discount)
//
// Execute via Railgun for full privacy (unshield → calls → reshield)
```

## Storing Receipts

After payment, the merchant issues a receipt. Store it locally:

```typescript
const receipt = prover.createReceipt(
  scopeCommitment,  // merchant or category
  amount,
  buyerCommitment,
  salt,             // from the merchant's receipt
  timestamp,
);

// Store in your proof cache
cache.addReceipts(merchantId, [receipt]);
```

Your receipts never leave your agent. They're the private data that ZK proofs are generated from.

## Proving Loyalty

When a merchant offers a loyalty discount, prove your spend threshold:

```typescript
const cache = new ProofCache(prover, BUYER_SECRET);

// Add your receipts
cache.addReceipts("coffee-shop", receipts);

// Pre-warm proofs in background (so they're instant at checkout)
cache.preWarm("coffee-shop", scopeCommitment, [
  50_000_000n,   // $50 threshold
  200_000_000n,  // $200 threshold
  500_000_000n,  // $500 threshold
]);

// At checkout — instant (0ms, proof was pre-generated)
const proof = await cache.getProof("coffee-shop", scopeCommitment, 200_000_000n);
```

### What the proof reveals:
- Your spend meets the threshold (boolean: yes/no)
- The merchant's scope commitment
- The threshold amount
- A nullifier (prevents replay)

### What the proof does NOT reveal:
- Your identity
- Your specific purchase amounts
- Your transaction history
- How much above the threshold you are

### Time-Bounded Proofs

Prove spend within a time window (e.g., last 90 days):

```typescript
const ninetyDaysAgo = BigInt(Math.floor(Date.now() / 1000)) - 86400n * 90n;

const proof = await prover.proveSpend({
  receipts: myReceipts,
  buyerSecret: BUYER_SECRET,
  scopeCommitment,
  threshold: 200_000_000n,
  minTimestamp: ninetyDaysAgo,
});
```

### Cross-Category LTV

Prove spend across all merchants in a category:

```typescript
// scopeCommitment = hash of category, not individual merchant
const categoryScope = prover.hash(COFFEE_CATEGORY_ID);

// Receipts from ALL coffee merchants go into one proof
const proof = await prover.proveSpend({
  receipts: allCoffeeReceipts, // from multiple merchants
  buyerSecret: BUYER_SECRET,
  scopeCommitment: categoryScope,
  threshold: 500_000_000n,
});
```

## Posting Stealth Intents

Want to find merchants without revealing your identity? Post an intent from an ephemeral stealth identity:

### 1. Create a throwaway identity

```typescript
import { generateStealthKeys, deriveStealthAddress } from "agora-protocol/sdk";

// Derive a stealth address from your OWN keys (not a merchant's)
const ephemeral = generateStealthKeys();

// Fund the stealth address via Railgun (unlinkable to your main identity)
// Only fund what you're willing to spend — this is your spending cap
```

### 2. Register a throwaway 8004 identity

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

### 3. Publish your intent

```json
{
  "category": "coffee",
  "maxPrice": 10000000,
  "loyaltyProofAvailable": true,
  "respondTo": "0x...stealth-address..."
}
```

### 4. Merchants respond to the stealth address

Merchants scan for `agora-intent` services, match your category, and send deal offers to your stealth address. You evaluate them locally and transact — all from the ephemeral identity.

After the transaction, abandon the stealth identity. The merchant never learns your real identity. The receipt goes into your private proof cache under your real `buyerSecret`.

## Privacy Summary

| Action | What's revealed | What's hidden |
|--------|----------------|---------------|
| Discovering deals | You queried a public endpoint | Your identity |
| Making payment | A stealth address paid a stealth address | Who paid, who received |
| Proving loyalty | Spend ≥ threshold (boolean) | Identity, amounts, history |
| Posting intent | "Someone wants coffee" | Who wants it |
| Receiving receipt | A purchase happened | Who the buyer is |

## Contract Addresses (Arbitrum)

```
MerchantRegistry: [deployed after hackathon submission]
LoyaltyManager:   [deployed after hackathon submission]
LoyaltyVerifier:  [deployed after hackathon submission]
```

## Architecture

```
You (Buyer Agent)                       Merchant Agent
     │                                       │
     ├─ Discover via 8004 registry ─────────▶│
     ├─ Fetch deals.json ──────────────────▶│
     ├─ Evaluate deals locally               │
     │                                       │
     ├─ Derive stealth address               │
     ├─ Fund via Railgun (unlinkable)        │
     ├─ Pay to merchant's stealth addr ────▶│
     │                                       │
     │  ◀── receipt (off-chain) ─────────────┤
     ├─ Store receipt locally                │
     │                                       │
     ├─ Generate ZK proof (cached, 0ms)      │
     ├─ Submit proof on-chain ─────────────▶│
     │                                       ├─ Verify proof
     │  ◀── discount applied ────────────────┤
     │                                       │
     │  Your identity is never revealed      │
```
