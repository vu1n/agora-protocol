# Agora: ZK Privacy-Commerce Protocol

**Zero-knowledge loyalty proofs for AI agents.** Merchants reward loyal customers without ever tracking them.

Built for [The Synthesis](https://synthesis.md) hackathon.

## What It Does

Agora lets a buyer's agent prove they've spent above a threshold with a merchant — without revealing their identity, transaction history, or specific amounts. The merchant verifies the proof on-chain and applies a loyalty discount. No customer database. No tracking. No data liability.

```
Buyer Agent                              Merchant Agent
    │                                         │
    │  purchases over time (private)          │
    ├────────────────────────────────────────▶│
    │                                         │
    │              receipts (stored locally)   │
    │◀────────────────────────────────────────┤
    │                                         │
    │  ZK proof: "I spent ≥ $500 with you"    │
    ├────────────────────────────────────────▶│
    │                                         │
    │  Merchant verifies on-chain             │
    │  Applies Silver tier discount (5%)      │
    │◀────────────────────────────────────────┤
    │                                         │
    │  Merchant never learns WHO the buyer is │
```

## Trust Model

**Merchant-published Merkle root is the trust anchor.**

1. Each purchase creates a receipt leaf: `Poseidon(sellerCommitment, amount, buyerCommitment, salt)`
2. The merchant inserts leaves into a Merkle tree and publishes the root on-chain via `MerchantRegistry`
3. The buyer's agent generates a Groth16 ZK proof against that on-chain root
4. `LoyaltyManager` reads the root from the registry (not from the caller) and verifies the proof
5. A nullifier `Poseidon(buyerSecret, merkleRoot)` prevents replay — one proof per buyer per root version

**What this prevents:**
- **Fabricated roots:** Root comes from on-chain registry, not the caller
- **Replay:** Nullifier bound to (buyer, root), marked as used on-chain
- **Impersonation:** `buyerCommitment` is embedded in every leaf — only the secret holder can prove
- **Tracking:** The merchant sees "someone qualified for Silver tier," not who

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     ZK Layer (Circom)                    │
│  loyalty_verify.circom — Groth16, 22,533 constraints    │
│  8 purchases max, Merkle depth 10 (1024 leaves)         │
│  Poseidon hashing, buyer commitment binding              │
└────────────────────────┬────────────────────────────────┘
                         │ generates
┌────────────────────────▼────────────────────────────────┐
│              Contract Layer (Solidity, Arbitrum)          │
│                                                          │
│  LoyaltyVerifier   — Auto-generated Groth16 verifier    │
│  MerchantRegistry  — Agent ID → signing key + root      │
│  LoyaltyManager    — Verifies proofs, tracks nullifiers │
└────────────────────────┬────────────────────────────────┘
                         │ called by
┌────────────────────────▼────────────────────────────────┐
│              Agent Layer (TypeScript)                     │
│                                                          │
│  AgoraProver — Builds Merkle trees, generates proofs    │
│  Demo        — End-to-end flow against Anvil/Arbitrum   │
└─────────────────────────────────────────────────────────┘
```

## Performance

| Metric | Value |
|--------|-------|
| Circuit constraints | 22,533 non-linear |
| Proof generation | ~2.4 seconds |
| On-chain verification gas | ~306k gas |
| On-chain verification cost (Arbitrum) | ~$0.05-0.10 |
| Per-purchase on-chain cost | $0 (receipts stored locally) |

## Quick Start

### Prerequisites

- [Circom](https://docs.circom.io/getting-started/installation/) compiler
- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, anvil)
- [Bun](https://bun.sh) or Node.js 18+

### Setup

```bash
# Install dependencies
cd agora
bun install

# Install circuit dependencies (circomlib, snarkjs)
cd ../sen-commerce/circuits && bun install && cd ../../agora

# Compile circuit (already done — artifacts in circuits/build/)
cd circuits
circom loyalty_verify.circom --r1cs --wasm --sym -o build -l ../../sen-commerce/circuits/node_modules

# Trusted setup
cd build
npx snarkjs groth16 setup loyalty_verify.r1cs powersOfTau28_hez_final_16.ptau loyalty_verify_0000.zkey
echo "hackathon entropy" | npx snarkjs zkey contribute loyalty_verify_0000.zkey loyalty_verify_final.zkey --name="Agora" -v
npx snarkjs zkey export verificationkey loyalty_verify_final.zkey verification_key.json
npx snarkjs zkey export solidityverifier loyalty_verify_final.zkey LoyaltyVerifier.sol
cd ../..

# Build contracts
cd contracts && forge build && cd ..
```

### Run Demo

```bash
# Start local chain
anvil &

# Run end-to-end demo
npx tsx src/demo.ts
```

### Run Contract Tests

```bash
cd contracts && forge test -vvv
```

## Contracts

| Contract | Description |
|----------|-------------|
| `LoyaltyVerifier.sol` | Auto-generated Groth16 verifier from circom circuit |
| `MerchantRegistry.sol` | Maps ERC-8004 agent IDs to merchant configs + Merkle roots |
| `LoyaltyManager.sol` | Orchestrates proof verification, nullifier tracking, events |

## Circuit

**`circuits/loyalty_verify.circom`** — Fixed and extended from `sen-commerce/circuits/loyalty_verify.circom`:

- **Added** `merkleRoot` as public input — all Merkle paths constrained against on-chain root
- **Added** `buyerSecret` private input and `buyerCommitment` in leaf hash — prevents impersonation
- **Added** `nullifier` as public output — `Poseidon(buyerSecret, merkleRoot)` prevents replay
- **Fixed** MerkleTreeChecker to use dual Mux1 for proper G1/G2 coordinate selection

Public signals: `[merkleRoot, sellerCommitment, threshold, purchaseCount]`
Public outputs: `[nullifier, valid]`

## What's Next

This hackathon demo proves the core protocol. Production extensions:

- **Railgun integration** — Shielded payments via Railgun's on-chain privacy pool. Buyer's agent pays from shielded balance; merchant receives without seeing sender identity.
- **Stealth addresses** — For non-Railgun merchants. One-time payment addresses prevent linking buyer to recipient.
- **Deal bazaar** — On-chain registry where merchants publish deals. Buyer agents subscribe and evaluate against private spend history.
- **ZK LTV proofs** — Prove lifetime value across *categories* of merchants, not just individual ones. "I'm a high spender on coffee" without revealing where.
- **EdDSA receipt signing** — Receipts signed with efficient EdDSA keys (Baby Jubjub) instead of ECDSA, reducing in-circuit verification cost.
- **Leaf uniqueness enforcement** — In-circuit check that no receipt is counted twice in a single proof.

## Hackathon Details

- **Agent:** Agora (registered on Base via ERC-8004)
- **Hackathon:** [The Synthesis](https://synthesis.md)
- **Built with:** Circom, snarkjs, Foundry, viem, TypeScript
- **Model:** Claude Opus 4.6
- **Harness:** Claude Code

## License

MIT
