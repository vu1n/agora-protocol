# Agora: Human-Agent Collaboration Log

Key architectural decisions from the build process.

## 1. ZK Loyalty Without Merchant Databases

**Problem:** Merchants need loyalty programs to retain customers, but traditional loyalty requires tracking individual purchase history. AI agents acting on behalf of humans inherit this data leakage at scale.

**Decision:** Use ZK proofs so buyers can prove spend thresholds without revealing identity. The merchant verifies a boolean ("this buyer spent >= $500") on-chain. No customer database. No PII. The buyer's agent holds the receipts privately.

## 2. Unified Circuit: One Proof for Three Use Cases

**Problem:** Per-merchant loyalty, cross-category LTV, and time-bounded proofs all require different circuits.

**Decision:** Use a single `scopeCommitment` field that can represent either a merchant ID (`hash(sellerId)`) or a category (`hash(categoryId)`). Add `minTimestamp` as a public input (0 = all-time). One 23k-constraint circuit handles all three cases. This reduces the on-chain footprint to a single verifier contract.

## 3. Merchant-Published Merkle Root as Trust Anchor

**Problem:** If the buyer supplies the Merkle root with their proof, they can fabricate receipts against a fake tree.

**Decision:** The merchant publishes their purchase tree root to `MerchantRegistry` on-chain. `LoyaltyManager` reads the root from the registry — callers cannot supply their own. The nullifier is bound to `Poseidon(buyerSecret, merkleRoot)`, preventing replay per tree version. This was caught during plan review — the original circuit had an unbound root.

## 4. ERC-8004 as the Bazaar

**Problem:** A separate bazaar contract is slow, expensive, and doesn't scale. Merchants shouldn't pay gas to post deals.

**Decision:** Merchants advertise through their ERC-8004 agent registration. The `agora-deals` service type points to a JSON deal catalog. The `agora-skill` service points to the buyer skill doc. Discovery is peer-to-peer via the existing 8004 registry — no new contract needed. This also directly satisfies the "Agents With Receipts" hackathon track requirements.

## 5. Stealth Intents: Anonymous Buyer Discovery

**Problem:** If a buyer publishes "looking to buy coffee" on their main identity, that's linkable to their loyalty proofs.

**Decision:** Buyers create throwaway stealth-address-backed ERC-8004 identities. Fund the stealth address via Railgun (one transaction budget). Post intent. Merchants respond. After the transaction, abandon the identity. The merchant never sees the buyer's real identity at any step.

## 6. TEE Relay Instead of SDK

**Problem:** The Railgun Wallet SDK requires LevelDB, 100MB+ artifacts, merkle tree scanning, and PPOI validation. No agent is going to set that up.

**Realization:** "Agents can't npm install." The integration surface needs to be HTTP, not a package.

**Decision:** Build a TEE relay that runs the Railgun engine on behalf of buyer agents. The buyer sends one HTTP POST. The relay generates the Railgun ZK proof inside an Intel TDX enclave, routes the payment through the shielded pool, and submits the transaction. Non-custodial: the proof is bound to a specific stealth address, the relay cannot redirect funds, and agents verify the enclave attestation before sending keys.

## 7. Phala Cloud TDX Over AWS Nitro

**Problem:** AWS Nitro enclaves have no networking — you need a vsock proxy on the parent instance to shuttle HTTP traffic. Minimum instance is 4 vCPU ($0.15/hr). Significant infrastructure setup.

**Decision:** Phala Cloud runs Docker containers directly in Intel TDX CVMs with automatic TLS endpoints. Deploy with `phala deploy`, get a public URL. $0.069/hr for a tdx.small. The relay is a standard Hono HTTP server — no vsock, no proxy, no Pulumi stack. Attestation via Intel DCAP, verifiable by anyone without trusting Phala.

## 8. Proof Cache for Instant Checkout

**Problem:** ZK proof generation takes ~2.2 seconds. That's too slow for a payment flow.

**Decision:** The buyer's agent pre-generates proofs in the background whenever receipts change. At checkout, the proof is a cache lookup — 0ms. The `ProofCache` class handles invalidation when new receipts arrive and deduplicates in-flight proof generation.

## 9. Three-Agent Architecture

**Final architecture:** Three cooperating agents form the privacy commerce network:

1. **Buyer agent** — holds keys, stores receipts, generates loyalty proofs, discovers deals via 8004, calls the relay for private payments
2. **TEE privacy relay** — runs Railgun engine inside Intel TDX, generates ZK proofs on buyer's behalf, submits transactions, charges a fee
3. **Merchant agent** — publishes deals via 8004, generates stealth keys, scans for payments, issues receipts, verifies loyalty proofs

No single agent sees the full picture. The buyer's identity stays private. The merchant gets verifiable loyalty signals. The relay facilitates but cannot steal.

## Technical Highlights

- **Circuit soundness fixes:** Three bugs caught during plan review — unbound Merkle root, replayable nullifier (buyerSecret not in leaf hash), non-quadratic constraint in MerkleTreeChecker. All fixed before compilation.
- **Conditional time checks:** Padding slots (amount=0) are exempt from the `minTimestamp` constraint via `IsZero(amount) → Mux1` — allows zero-timestamp padding leaves when proving time-bounded spend.
- **B-point coordinate swap:** snarkjs stores G2 points as `[real, imag]` but the EVM BN128 precompile expects `[imag, real]`. Caught by Foundry test failure, fixed in `formatForSolidity`.
- **Zero-hash tree optimization:** Precomputed zero subtree hashes per level. Skips ~90% of Poseidon calls during tree construction. Tree build: ~300ms → ~25ms.
- **66 verification assertions:** 21 TypeScript, 9 Foundry unit, 3 invariant fuzz (128k calls), 4 Halmos symbolic, 8 circuit negative, 21 E2E through the relay.
