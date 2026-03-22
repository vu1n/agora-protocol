# Agora: Private Commerce for AI Agents

**An SDK for private commerce. Two payment modes. Zero-knowledge loyalty. No hosted infrastructure.**

Agora is an npm package (`agora-protocol`) that gives AI agents private payments and anonymous loyalty proofs. Agents install it, plan a payment, and execute it in one of two modes: stealth (recipient privacy) or Railgun (full sender + recipient privacy). Merchants never see the buyer. The buyer never touches raw cryptography.

Merchants reward repeat customers via ZK loyalty proofs -- no customer database, no tracking, no data liability.

Built for [The Synthesis](https://synthesis.md) hackathon.

## Architecture

```
Buyer Agent                                                    Merchant Agent
     |                                                              |
     |-- import { AgoraExecutor, planAgoraRecipe } from "agora-protocol"
     |                                                              |
     |-- 1. Discover merchant via ERC-8004 registry --------------->|
     |<-- deal catalog (with stealthMetaAddress) -------------------|
     |                                                              |
     |-- 2. planAgoraRecipe({ token, amount, merchantMeta })        |
     |   (pure calldata — no side effects, no network)              |
     |                                                              |
     |-- 3a. executeStealth(plan, walletClient)                     |
     |       OR                                                     |
     |-- 3b. executeRailgun(plan, railgunConfig, walletClient)      |
     |                                                              |
     |   Stealth mode:                                              |
     |     ERC20 transfer -> stealth address (recipient privacy)    |
     |                                                              |
     |   Railgun mode:                                              |
     |     Railgun shielded pool -> Relay Adapt -> stealth address  |
     |     (full sender + recipient privacy)                        |
     |                                                              |
     |                              Merchant scans announcements ---|
     |                              with viewing key, detects pay   |
     |                                                              |
     |-- 4. ZK loyalty proof -----------------------------(on-chain verify)
     |   "I spent >= $500 at your                                   |
     |    shop" — no identity                                       |
     |    revealed                                                  |
```

**Two modes, one planner.** Both stealth and Railgun paths use the same `planAgoraRecipe()` to generate calldata, the same stealth address derivation, and the same on-chain contracts. The executor decides how to submit.

## Live Deployment

| Component | Location |
|-----------|----------|
| **LoyaltyVerifier** | Arbitrum [`0x2153...4eBd`](https://arbiscan.io/address/0x21535e0418F11551f1BcA480e2366631E3174eBd) |
| **MerchantRegistry** | Arbitrum [`0xc908...1DF2`](https://arbiscan.io/address/0xc908B8883B3A14C8c4972f506a041318EDCe1DF2) |
| **LoyaltyManager** | Arbitrum [`0x7E68...800e`](https://arbiscan.io/address/0x7E68F87f59D141FBc5021E2F528d683739bb800e) |
| **Agent Identity** | Base ERC-8004 #35295 |
| **Source** | [github.com/vu1n/agora-protocol](https://github.com/vu1n/agora-protocol) |

## Privacy Model

### Two Payment Modes

**Stealth mode (default):** The agent derives a one-time stealth address from the merchant's meta-address (ERC-5564) and sends ERC20 tokens directly. The merchant scans announcements with their viewing key to detect payments. Recipient privacy is guaranteed -- nobody can link the stealth address to the merchant. The sender's wallet is visible on-chain.

**Railgun mode (full privacy):** The agent has a Railgun engine initialized via `@railgun-community/wallet`. The SDK calls `generateCrossContractCallsProof` and `populateProvedCrossContractCalls` to route the payment through Railgun's shielded pool via the Relay Adapt contract to a stealth address. Both sender and recipient are private. The on-chain transaction shows `Relay Adapt -> stealth address` -- no link back to the buyer's wallet.

### Recipient Privacy (ERC-5564 Stealth Addresses)

Buyer derives a one-time stealth address from the merchant's public meta-address. Merchant scans announcements with their viewing key. Neither side learns the other's real address.

### Stealth Intents

Buyers can post "looking to buy X" from throwaway stealth-address-backed ERC-8004 identities. Fund one transaction, use once, discard. Merchants discover and respond. Buyer stays anonymous.

## ZK Loyalty Proofs

### Three Use Cases, One Circuit

| Use case | scopeCommitment | minTimestamp | Example |
|----------|----------------|-------------|---------|
| **Per-merchant loyalty** | `hash(sellerId)` | `0` (all time) | "I spent >= $500 at your shop" |
| **Time-bounded loyalty** | `hash(sellerId)` | `now - 90 days` | "I spent >= $300 in the last quarter" |
| **Cross-category LTV** | `hash(categoryId)` | `0` or bounded | "I spent >= $400 across all coffee shops" |

The merchant publishes a Merkle root of purchase receipts on-chain. The buyer proves inclusion against that root. `LoyaltyManager` reads the root directly from `MerchantRegistry` -- callers cannot supply their own. Nullifier = `Poseidon(buyerSecret, merkleRoot)` prevents proof replay.

## Deal Discovery via ERC-8004

No separate bazaar contract. Merchants advertise through their ERC-8004 agent registration:

```json
{
  "services": [
    { "type": "agora-deals", "endpoint": "https://shop.example/deals.json" },
    { "type": "agora-skill", "endpoint": "https://github.com/vu1n/agora-protocol/blob/main/skill-buyer.md" }
  ]
}
```

Buyer agents discover merchants via the 8004 registry, fetch deal catalogs peer-to-peer, and evaluate locally against private spend history.

## Performance

| Metric | Value |
|--------|-------|
| Circuit constraints | 23,245 non-linear |
| Proof generation (cold) | ~2.2s |
| Proof generation (cached) | 0ms |
| On-chain verification gas | ~306k |
| On-chain verification cost (Arbitrum) | ~$0.05-0.10 |
| Per-purchase on-chain cost | $0 (receipts stored locally) |

## Testing & Verification

**63 total assertions across 6 verification layers:**

| Layer | Tool | Tests | Result |
|-------|------|-------|--------|
| TypeScript unit + integration | bun test | 21 tests | 21/21 pass |
| Solidity unit tests | Foundry | 9 tests with real Groth16 proofs | 9/9 pass |
| Stateful invariant fuzz | Foundry | 128k random call sequences, 3 invariants | 3/3 hold |
| Symbolic verification | Halmos | Access control + root binding | 4 proofs verified |
| Circuit adversarial | Circom/snarkjs | 8 negative inputs (wrong buyer, wrong scope, expired, etc.) | 8/8 rejected |
| Circuit static analysis | Circomspect | Full circuit | Clean |
| End-to-end | TypeScript | 20 assertions (stealth + on-chain + scanning) | 20/20 pass |

## Project Structure

```
agora/
  circuits/
    loyalty_verify.circom     <- unified ZK circuit (loyalty + LTV + time-bounded)
    generate_test_witness.mjs <- smoke test
    negative_tests.mjs        <- 8 adversarial input tests
  contracts/
    src/
      LoyaltyVerifier.sol     <- auto-generated Groth16 verifier
      MerchantRegistry.sol    <- agent ID -> signing key + Merkle root
      LoyaltyManager.sol      <- proof verification + nullifier tracking
    test/
      LoyaltyManager.t.sol           <- 9 unit tests with real proofs
      LoyaltyManager.invariant.t.sol <- stateful fuzz testing (128k calls)
      LoyaltyManager.symbolic.t.sol  <- Halmos symbolic verification
  src/
    prover.ts          <- Poseidon Merkle tree + Groth16 proof generation
    proof-cache.ts     <- pre-generates proofs for instant checkout
    types.ts
    demo.ts            <- end-to-end demo (3 proof types)
    e2e.ts             <- full stealth + on-chain integration test
    sdk/
      index.ts         <- SDK public surface (exports)
      stealth.ts       <- ERC-5564 stealth address derivation
      recipe.ts        <- payment + loyalty proof orchestration
      executor.ts      <- stealth + Railgun execution modes
      bazaar.ts        <- deal discovery via ERC-8004 agent cards
      types.ts         <- shared types (CallIntent, RecipePlan, etc.)
      steps/
        payment.ts     <- stealth payment calldata generation
        loyalty.ts     <- ZK proof submission calldata generation
  skill-buyer.md       <- agent skill doc for buyers
  skill-merchant.md    <- agent skill doc for merchants
```

## Quick Start

```bash
# Install dependencies
bun install

# Run TypeScript tests
bun test

# Run contract tests
cd contracts && forge test -vvv

# Run circuit negative tests
cd circuits && node negative_tests.mjs

# Run full E2E (needs Anvil)
anvil &
npx tsx src/e2e.ts
```

## Agent Skill Docs

- **[Buyer Skill](./skill-buyer.md)** -- how buyer agents install the SDK, pay privately, prove loyalty
- **[Merchant Skill](./skill-merchant.md)** -- how merchant agents register, publish deals, verify proofs

## What's Next

- **Full Railgun engine helper** -- convenience wrapper for `startRailgunEngine` + `createRailgunWallet` + `loadProvider` to reduce init boilerplate for agents choosing Railgun mode
- **EdDSA receipt signing** -- Baby Jubjub signatures for efficient in-circuit receipt verification (currently receipts are unsigned)
- **Leaf uniqueness in-circuit** -- enforce that the same receipt cannot be counted twice within a single proof

## Hackathon

- **Agent:** Agora (ERC-8004 identity on Base, agent #35295)
- **Hackathon:** [The Synthesis](https://synthesis.md)
- **Tracks:** Private Agents Trusted Actions (Venice), Synthesis Open Track, Agents With Receipts (Protocol Labs), Future of Commerce (Slice)
- **Built with:** Circom, snarkjs, Foundry, Halmos, viem, @railgun-community/wallet, TypeScript
- **Model:** Claude Opus 4.6 | **Harness:** Claude Code

## License

MIT
