# Agora: ZK Privacy-Commerce Protocol

**Private payments. Zero-knowledge loyalty. No tracking.**

Agora lets AI agents transact privately and prove customer loyalty without revealing identity. Merchants reward loyal customers via ZK proofs — no customer database, no tracking, no data liability.

Built for [The Synthesis](https://synthesis.md) hackathon.

## How It Works

```
Buyer Agent                              Merchant Agent
     │                                       │
     ├─ Discover merchant via ERC-8004 ─────▶│
     ├─ Fetch deals from agent card ────────▶│
     │                                       │
     ├─ Derive stealth address               │
     ├─ Fund via Railgun (unlinkable)        │
     ├─ Pay to merchant's stealth addr ────▶│  (neither side sees the other's identity)
     │                                       │
     │  ◀── receipt (off-chain) ─────────────┤
     ├─ Store receipt locally                │
     │                                       │
     ├─ ZK proof: "I spent ≥ $500 with you"  │
     ├─ Submit proof on-chain ─────────────▶│  (merchant verifies, applies discount)
     │                                       │
     │  Buyer identity never revealed        │
```

## Three Proof Types, One Circuit

| Use case | scopeCommitment | minTimestamp | Example |
|----------|----------------|-------------|---------|
| **Per-merchant loyalty** | `hash(sellerId)` | `0` (all time) | "I spent ≥$500 at your shop" |
| **Time-bounded loyalty** | `hash(sellerId)` | `now - 90 days` | "I spent ≥$300 at your shop in the last 90 days" |
| **Cross-category LTV** | `hash(categoryId)` | `0` or bounded | "I spent ≥$400 across all coffee shops" |

One unified Circom circuit handles all three. The merchant decides what thresholds matter — the protocol just proves facts.

## Trust Model

**Merchant-published Merkle root is the trust anchor.**

- Merchant builds a Merkle tree of purchase receipts and publishes the root on-chain
- Buyer proves inclusion of their purchases against that on-chain root
- `LoyaltyManager` reads the root from `MerchantRegistry` — callers cannot supply their own
- Nullifier = `Poseidon(buyerSecret, merkleRoot)` — one proof per buyer per root version
- `buyerCommitment` in every leaf prevents impersonation

## Privacy Layers

**Stealth addresses (ERC-5564):** Buyer derives a one-time address from the merchant's public meta-address. Merchant scans announcements with their viewing key to detect payments. Neither side learns the other's identity.

**Railgun integration:** Stealth addresses are funded from the Railgun shielded pool, breaking the on-chain link between buyer and payment. The SDK provides a Recipe pattern — a client-side orchestration layer that generates typed call intents, executed through Railgun's Relay Adapt contract.

**Stealth intents:** Buyers can post "looking to buy X" from throwaway stealth-address-backed ERC-8004 identities. Funded only for one transaction. Merchants discover and respond. Buyer stays anonymous.

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

Buyer agents discover merchants via the 8004 registry, fetch deal catalogs peer-to-peer, and evaluate them locally against private spend history. The `agora-skill` service link lets new buyers onboard automatically.

## Performance

| Metric | Value |
|--------|-------|
| Circuit constraints | 23,245 non-linear |
| Proof generation (cold) | ~2.2s |
| Proof generation (cached) | 0ms |
| On-chain verification gas | ~306k |
| On-chain verification cost (Arbitrum) | ~$0.05-0.10 |
| Per-purchase on-chain cost | $0 (receipts stored locally) |

## Project Structure

```
agora/
  circuits/
    loyalty_verify.circom     ← unified ZK circuit (loyalty + LTV + time-bounded)
    generate_test_witness.mjs ← smoke test
    negative_tests.mjs        ← adversarial input tests
  contracts/
    src/
      LoyaltyVerifier.sol     ← auto-generated Groth16 verifier
      MerchantRegistry.sol    ← agent ID → signing key + Merkle root
      LoyaltyManager.sol      ← proof verification + nullifier tracking
    test/
      LoyaltyManager.t.sol           ← 9 unit tests with real proofs
      LoyaltyManager.invariant.t.sol ← stateful fuzz testing (128k call sequences)
      LoyaltyManager.symbolic.t.sol  ← Halmos symbolic verification
  src/
    prover.ts          ← Poseidon Merkle tree + Groth16 proof generation
    proof-cache.ts     ← pre-generates proofs for instant checkout
    types.ts
    demo.ts            ← end-to-end demo (3 proof types)
    sdk/
      stealth.ts       ← ERC-5564 stealth address derivation
      recipe.ts        ← client-side payment + loyalty proof orchestration
      executor.ts      ← Railgun integration boundary + simulation
      bazaar.ts        ← deal discovery via ERC-8004 agent cards
      steps/
        payment.ts     ← stealth payment calldata generation
        loyalty.ts     ← ZK proof submission calldata generation
  skill-buyer.md       ← agent skill doc for buyers
  skill-merchant.md    ← agent skill doc for merchants
```

## Testing & Verification

| Tool | What | Result |
|------|------|--------|
| **Foundry unit tests** | 9 tests with real Groth16 proof verification | 9/9 pass |
| **Foundry invariant fuzz** | 128k random call sequences, 3 invariants | 3/3 hold |
| **Halmos symbolic** | Formal verification of access control + root binding | 4/6 proven (2 errored on ecPairing) |
| **Circomspect** | Static analysis of circom circuit | Clean |
| **Circuit negative tests** | 8 adversarial inputs (wrong buyer, wrong scope, expired, etc.) | 8/8 correctly rejected |

## Quick Start

```bash
# Install dependencies
bun install
cd ../sen-commerce/circuits && bun install && cd ../../agora

# Run demo (start Anvil first)
anvil &
npx tsx src/demo.ts

# Run contract tests
cd contracts && forge test -vvv

# Run circuit smoke test
cd circuits && node generate_test_witness.mjs

# Run circuit negative tests
cd circuits && node negative_tests.mjs

# Run benchmark (proof cache performance)
npx tsx src/bench.ts
```

## Agent Skill Docs

- **[Buyer Skill](./skill-buyer.md)** — how buyer agents discover deals, pay privately, prove loyalty
- **[Merchant Skill](./skill-merchant.md)** — how merchant agents register, publish deals, verify proofs

## What's Next

- **Full Railgun SDK wiring** — the executor interface is defined, connecting to `@railgun-community/wallet` for actual shielded pool operations
- **Stealth intent marketplace** — ephemeral 8004 identities for anonymous buyer-side discovery
- **EdDSA receipt signing** — Baby Jubjub signatures for efficient in-circuit receipt verification
- **Leaf uniqueness enforcement** — in-circuit check preventing duplicate receipt counting
- **Production Arbitrum deployment** — contracts verified on Arbiscan

## Hackathon

- **Agent:** Agora (ERC-8004 identity on Base, agent #35295)
- **Hackathon:** [The Synthesis](https://synthesis.md)
- **Tracks:** Private Agents Trusted Actions (Venice), Synthesis Open Track, Agents With Receipts (Protocol Labs), Future of Commerce (Slice)
- **Built with:** Circom, snarkjs, Foundry, viem, TypeScript
- **Model:** Claude Opus 4.6 | **Harness:** Claude Code

## License

MIT
