# Agora: Private Commerce for AI Agents

**One HTTP call. Private payment. Zero-knowledge loyalty. No SDK required.**

Agora is a three-agent protocol where AI agents buy and sell without revealing who they are. A buyer agent sends a single HTTP request to a TEE privacy relay, which generates Railgun ZK proofs inside an Intel TDX enclave. The merchant never sees the buyer. The buyer never touches Railgun directly.

Merchants reward repeat customers via ZK loyalty proofs -- no customer database, no tracking, no data liability.

Built for [The Synthesis](https://synthesis.md) hackathon.

## Architecture

```
Buyer Agent                  TEE Privacy Relay               Merchant Agent
     |                       (Phala Cloud TDX)                     |
     |                                                             |
     |-- 1. GET /attestation ------>|                              |
     |<-- TDX quote + code hash ----|                              |
     |   (verify enclave before                                    |
     |    sending anything)                                        |
     |                                                             |
     |-- 2. POST /pay ------------>|                               |
     |   { token, amount,          |                               |
     |     merchantStealthMeta }   |                               |
     |                             |-- Railgun Relay Adapt ------->|
     |                             |   (shielded pool -> stealth)  |
     |                             |                               |
     |<-- stealth announcement ----|                               |
     |                                                             |
     |                              Merchant scans announcements --|
     |                              with viewing key, detects pay  |
     |                                                             |
     |-- 3. ZK loyalty proof -----------------------------(on-chain verify)
     |   "I spent >= $500 at your                                  |
     |    shop" — no identity                                      |
     |    revealed                                                 |
```

**Three agents, one relay call.** The buyer agent never installs Railgun. The relay does the heavy cryptography inside TDX. The merchant scans stealth address announcements to detect payments.

## Live Deployment

| Component | Location |
|-----------|----------|
| **LoyaltyVerifier** | Arbitrum [`0xF1Ea...7874`](https://arbiscan.io/address/0xF1Ea8695FEbfc104F095c093474ddC466EB67874) |
| **MerchantRegistry** | Arbitrum [`0xE876...0583`](https://arbiscan.io/address/0xE876EeC58E79Db135d9E5Fd93E91aBf54eA4f583) |
| **LoyaltyManager** | Arbitrum [`0xf66F...B353`](https://arbiscan.io/address/0xf66FB40f0ABD88Aa31dD88a2EfE65059143dB353) |
| **TEE Privacy Relay** | Phala TDX [`relay endpoint`](https://7c8a9578d4e316b426d8ea3556e25e99e3c95bad-3100.dstack-pha-prod5.phala.network) |
| **Agent Identity** | Base ERC-8004 #35295 |
| **Source** | [github.com/vu1n/agora-protocol](https://github.com/vu1n/agora-protocol) |

## Privacy Model

### Non-Custodial TEE Relay

The relay runs inside an Intel TDX enclave on Phala Cloud. It generates Railgun ZK proofs on behalf of the buyer but **cannot steal keys or redirect funds**:

- **Enclave isolation:** The TDX hardware isolates all key material. The relay operator cannot inspect enclave memory.
- **Attestation-first:** Buyer agents call `GET /attestation` and verify the TDX quote (bound to the Docker image hash) before sending any sensitive data. No trust in Phala required -- verification is via Intel DCAP.
- **Proof binding:** Each proof authorizes a specific payment to a specific stealth address. The relay cannot rewrite the destination.

### Sender Privacy (Railgun)

Funds move through Railgun's shielded pool via the Relay Adapt contract. The on-chain transaction shows `Relay Adapt -> stealth address` -- no link back to the buyer's wallet.

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

**66 total assertions across 6 verification layers:**

| Layer | Tool | Tests | Result |
|-------|------|-------|--------|
| TypeScript unit + integration | bun test | 21 tests | 21/21 pass |
| Solidity unit tests | Foundry | 9 tests with real Groth16 proofs | 9/9 pass |
| Stateful invariant fuzz | Foundry | 128k random call sequences, 3 invariants | 3/3 hold |
| Symbolic verification | Halmos | Access control + root binding | 4 proofs verified |
| Circuit adversarial | Circom/snarkjs | 8 negative inputs (wrong buyer, wrong scope, expired, etc.) | 8/8 rejected |
| Circuit static analysis | Circomspect | Full circuit | Clean |
| End-to-end | TypeScript | 21 assertions (relay + on-chain + stealth scanning) | 21/21 pass |

## Project Structure

```
agora/
  relay/
    index.ts                  <- Hono server (Phala TDX deployment)
    routes/
      pay.ts                  <- POST /pay — stealth payment via Railgun
      shield.ts               <- POST /shield — deposit into shielded pool
      attestation.ts          <- GET /attestation — TDX quote for agents
      health.ts               <- GET /health
    constants.ts              <- chain config + contract addresses
    Dockerfile                <- Bun alpine image for Phala Cloud CVM
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
    e2e.ts             <- full relay + on-chain integration test
    sdk/
      stealth.ts       <- ERC-5564 stealth address derivation
      recipe.ts        <- payment + loyalty proof orchestration
      executor.ts      <- Railgun integration boundary + simulation
      bazaar.ts        <- deal discovery via ERC-8004 agent cards
      steps/
        payment.ts     <- stealth payment calldata generation
        loyalty.ts     <- ZK proof submission calldata generation
  skill-buyer.md       <- agent skill doc for buyers
  skill-merchant.md    <- agent skill doc for merchants
  phala.toml           <- Phala Cloud deployment config
```

## Quick Start

```bash
# Install dependencies
bun install

# Run the relay locally
bun run relay/index.ts

# Run TypeScript tests
bun test

# Run contract tests
cd contracts && forge test -vvv

# Run circuit negative tests
cd circuits && node negative_tests.mjs

# Run full E2E (needs Anvil + local relay)
anvil &
bun run relay/index.ts &
npx tsx src/e2e.ts
```

## Agent Skill Docs

- **[Buyer Skill](./skill-buyer.md)** -- how buyer agents discover deals, pay privately, prove loyalty
- **[Merchant Skill](./skill-merchant.md)** -- how merchant agents register, publish deals, verify proofs

## What's Next

- **Full Railgun engine wiring in TEE** -- the relay currently plans the payment and generates stealth calldata, but does not yet submit the final Railgun proof through the shielded pool
- **Real TDX attestation quotes** -- the Nitro attestation endpoint returns mock quotes in dev; production needs to return verifiable Intel TDX quotes via Phala's dstack SDK
- **EdDSA receipt signing** -- Baby Jubjub signatures for efficient in-circuit receipt verification (currently receipts are unsigned)
- **Leaf uniqueness in-circuit** -- enforce that the same receipt cannot be counted twice within a single proof

## Hackathon

- **Agent:** Agora (ERC-8004 identity on Base, agent #35295)
- **Hackathon:** [The Synthesis](https://synthesis.md)
- **Tracks:** Private Agents Trusted Actions (Venice), Synthesis Open Track, Agents With Receipts (Protocol Labs), Future of Commerce (Slice)
- **Built with:** Circom, snarkjs, Foundry, Halmos, Hono, viem, Phala Cloud, TypeScript
- **Model:** Claude Opus 4.6 | **Harness:** Claude Code

## License

MIT
