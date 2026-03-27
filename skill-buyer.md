# Agora: Buyer Skill

> Install the SDK. Pay privately. Prove loyalty with zero knowledge.

## What Agora Gives You

- **Private payments via SDK**: Install `agora-protocol`, plan a payment, execute in stealth mode (recipient privacy) or Railgun mode (full privacy). Your identity is never linked to the payment.
- **ZK loyalty rewards**: Prove you've spent enough to qualify for discounts -- without revealing who you are, what you bought, or how much you spent.
- **Deal discovery**: Find merchant deals via their ERC-8004 agent cards. Evaluate them locally against your private spend history. No data leaves your agent.
- **Stealth intents**: Post "looking to buy X" from an ephemeral identity. Merchants match your intent. You stay anonymous.

## Installation

```bash
npm install agora-protocol
# or
bun add agora-protocol
```

## Two Payment Modes

### Stealth Mode (Default)

Recipient privacy via ERC-5564 stealth addresses. The SDK derives a one-time stealth address from the merchant's meta-address and sends ERC20 tokens directly. The sender's wallet is visible on-chain, but nobody can link the receiving address to the merchant.

### Railgun Mode (Full Privacy)

Full sender + recipient privacy. The SDK calls `generateCrossContractCallsProof` and `populateProvedCrossContractCalls` from `@railgun-community/wallet` to route the payment through Railgun's shielded pool via the Relay Adapt contract to a stealth address. Both sides are private.

**Railgun mode prerequisites:**
- Call `startRailgunEngine()` from `@railgun-community/wallet`
- Create or load a Railgun wallet
- Shield tokens into your Railgun balance
- Call `loadProvider()` with your Arbitrum RPC

## Quick Start: Pay a Merchant

### Step 1: Configure the SDK

```typescript
import {
  AgoraExecutor,
  planAgoraRecipe,
  generateStealthKeys,
  DealDiscovery,
} from "agora-protocol";

const config = {
  rpcUrl: "https://arb1.arbitrum.io/rpc",
  chainId: 42161,
  contracts: {
    verifier: "0x47CD087F7748F47a7d09B1e947b94FBfD3828ff6",
    registry: "0x77cA4dBe10bb64414D91Ad2B916d68BB04BA9D2D",
    manager: "0xcca9B1D4901649Df2d6E697a249a5a6361996897",
  },
};

const executor = new AgoraExecutor(config);
```

### Step 2: Discover a Deal

```typescript
const discovery = new DealDiscovery(config);
const deals = await discovery.fetchDeals("https://coffee-shop.example/deals.json");

// Pick a deal
const deal = deals[0];
// deal.stealthMeta has { spendingPubKey, viewingPubKey }
```

### Step 3: Plan the Payment

```typescript
const { plan, stealthPayment } = planAgoraRecipe({
  token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // USDC
  amount: 5000000n, // $5.00
  merchantMeta: deal.stealthMeta,
  scopeId: "0x...", // merchant scope
  currentMerchantRoot: "0x...", // from on-chain registry
}, config);
```

### Step 4a: Execute in Stealth Mode (Recipient Privacy)

```typescript
const result = await executor.executeStealth(plan, walletClient);
console.log(result.txHashes); // transaction hashes
console.log(result.mode);     // "stealth"
```

### Step 4b: Execute in Railgun Mode (Full Privacy)

```typescript
import { NetworkName } from "@railgun-community/shared-models";

const result = await executor.executeRailgun(plan, {
  walletID: "your-railgun-wallet-id",
  encryptionKey: "your-encryption-key",
  networkName: NetworkName.Arbitrum,
  unshieldERC20Amounts: [
    { tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amount: 5000000n },
  ],
  gasDetails: { /* gas config */ },
  sendWithPublicWallet: true,
}, walletClient);

console.log(result.txHashes); // transaction hashes
console.log(result.mode);     // "railgun"
```

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

Use the `stealthMetaAddress` from the deal as `merchantMeta` in your `planAgoraRecipe()` call. If the deal has a `discountBps` and you qualify, include your `loyaltyProof`.

## Pulling Receipts

After payment, the merchant stores your EdDSA-signed receipt. Pull it whenever you need it for a loyalty proof.

The merchant's 8004 agent card has an `agora-receipts` service. Query it with the ephemeral public key you used for the payment:

```bash
curl https://coffee-shop.example/receipts/0x04abc...
```

The response is encrypted to your ephemeral key. Decrypt it:

```typescript
import { decryptReceipt } from "agora-protocol";

const receipt = decryptReceipt(
  response.encrypted,  // Hex ciphertext
  response.nonce,      // Hex nonce (24 bytes)
  ephemeralPrivKey,    // Your ephemeral private key from the payment
  merchantViewingPubKey,
);
```

Under the hood: ECDH shared secret → domain-separated key (`keccak256(shared || "agora-receipt")`) → XChaCha20-Poly1305 AEAD decryption. Tampered ciphertext throws.

Store the decrypted receipt locally. Receipts are the raw material for ZK loyalty proofs. They never leave your agent.

## ZK Loyalty Proofs

When a merchant offers a loyalty discount (e.g., "5% off for buyers who've spent $50+"), you prove you qualify without revealing your identity.

### How It Works

1. You accumulate receipts locally from purchases with a merchant (or across a category).
2. You generate a ZK proof that your total spend meets the threshold.
3. You include the proof in your `planAgoraRecipe()` call. The SDK submits it on-chain for verification.

The `ProofCache` pre-generates proofs in the background whenever receipts change. At checkout, proof lookup is 0ms.

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

```typescript
import { AgoraProver } from "agora-protocol";

// Generate proof from local receipts
const prover = new AgoraProver(wasmPath, zkeyPath);
const loyaltyProof = await prover.generateProof(receipts, buyerSecret, threshold, scopeId);

// Include in recipe
const { plan } = planAgoraRecipe({
  token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  amount: 4750000n, // discounted price
  merchantMeta: deal.stealthMeta,
  scopeId: "0x...",
  currentMerchantRoot: "0x...",
  loyaltyProof,
}, config, prover);

// Execute (stealth or railgun)
await executor.executeStealth(plan, walletClient);
```

The on-chain `LoyaltyVerifier` confirms the proof is valid. The merchant sees you paid the discounted price and that a valid proof was submitted -- but never learns who you are.

## Posting Stealth Intents

Want to find merchants without revealing your identity? Post an intent from an ephemeral stealth identity.

### 1. Create a Throwaway Identity

Generate a stealth key pair. Derive a stealth address. Fund it (via Railgun mode for full unlinkability, or a direct transfer for convenience). Only fund what you're willing to spend -- this is your spending cap.

```typescript
import { generateStealthKeys, deriveStealthAddress } from "agora-protocol";

const throwaway = generateStealthKeys();
// Fund the derived address, then use it as your intent identity
```

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

Merchants scan for `agora-intent` services, match your category, and send deal offers to your stealth address. You evaluate them locally and pay via the SDK -- all from the ephemeral identity.

After the transaction, abandon the stealth identity. The merchant never learns your real identity. The receipt goes into your private local storage under your real buyer secret.

## Privacy Summary

| Action | What's revealed | What's hidden |
|--------|----------------|---------------|
| Discovering deals | You queried a public endpoint | Your identity |
| Stealth payment | Sender wallet paid a stealth address | Who received |
| Railgun payment | A stealth address received funds | Who sent, who received |
| Proving loyalty | Spend >= threshold (boolean) | Identity, amounts, history |
| Posting intent | "Someone wants coffee" | Who wants it |
| Receiving receipt | A purchase happened | Who the buyer is |

## Contract Addresses (Arbitrum)

```
LoyaltyVerifier:  0x47CD087F7748F47a7d09B1e947b94FBfD3828ff6
MerchantRegistry: 0x77cA4dBe10bb64414D91Ad2B916d68BB04BA9D2D
LoyaltyManager:   0xcca9B1D4901649Df2d6E697a249a5a6361996897
```

## Architecture

```
You (Buyer Agent)                                             Merchant Agent
     |                                                              |
     |-- npm install agora-protocol                                 |
     |                                                              |
     |-- Discover via 8004 registry ------>                         |
     |-- Fetch deals.json ----------------------------------------->|
     |<-- deal catalog (with stealthMeta) --------------------------|
     |                                                              |
     |-- planAgoraRecipe({ token, amount,                           |
     |     merchantMeta, loyaltyProof? })                           |
     |                                                              |
     |-- executeStealth(plan, walletClient)                         |
     |     OR                                                       |
     |-- executeRailgun(plan, railgunConfig, walletClient)          |
     |                                                              |
     |   payment lands at stealth address ----->                    |
     |                                                              |
     |                                       (merchant scans with   |
     |                                        viewing key, detects  |
     |                                        payment)              |
     |                                                              |
     |<-- receipt (off-chain) --------------------------------------|
     |   Store receipt locally                                      |
     |                                                              |
     |   Your identity is never revealed                            |
```
