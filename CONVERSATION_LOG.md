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

**Decision:** The merchant publishes their purchase tree root to `MerchantRegistry` on-chain. `LoyaltyManager` reads the root from the registry -- callers cannot supply their own. The nullifier is bound to `Poseidon(buyerSecret, merkleRoot)`, preventing replay per tree version. This was caught during plan review -- the original circuit had an unbound root.

## 4. ERC-8004 as the Bazaar

**Problem:** A separate bazaar contract is slow, expensive, and doesn't scale. Merchants shouldn't pay gas to post deals.

**Decision:** Merchants advertise through their ERC-8004 agent registration. The `agora-deals` service type points to a JSON deal catalog. The `agora-skill` service points to the buyer skill doc. Discovery is peer-to-peer via the existing 8004 registry -- no new contract needed. This also directly satisfies the "Agents With Receipts" hackathon track requirements.

## 5. Stealth Intents: Anonymous Buyer Discovery

**Problem:** If a buyer publishes "looking to buy coffee" on their main identity, that's linkable to their loyalty proofs.

**Decision:** Buyers create throwaway stealth-address-backed ERC-8004 identities. Fund the stealth address via Railgun (one transaction budget). Post intent. Merchants respond. After the transaction, abandon the identity. The merchant never sees the buyer's real identity at any step.

## 6. TEE Relay: The Road Not Taken

**Problem:** The Railgun Wallet SDK requires LevelDB, 100MB+ artifacts, merkle tree scanning, and PPOI validation. No agent is going to set that up.

**Initial decision:** Build a TEE relay that runs the Railgun engine on behalf of buyer agents. The buyer sends one HTTP POST. The relay generates the Railgun ZK proof inside an Intel TDX enclave, routes the payment through the shielded pool, and submits the transaction.

**What happened:** We built it. Deployed it to Phala Cloud. Got the TDX endpoint live. Then realized the fundamental flaw -- see decision #10.

## 7. Phala Cloud TDX: Used and Discarded

**Problem:** AWS Nitro enclaves have no networking -- you need a vsock proxy on the parent instance to shuttle HTTP traffic. Minimum instance is 4 vCPU ($0.15/hr). Significant infrastructure setup.

**Decision:** Phala Cloud runs Docker containers directly in Intel TDX CVMs with automatic TLS endpoints. Deploy with `phala deploy`, get a public URL. $0.069/hr for a tdx.small. The relay was a standard Hono HTTP server -- no vsock, no proxy, no Pulumi stack.

**Outcome:** The Phala deployment worked. The relay ran. But the architecture was wrong (see #10). The relay code was deleted. Phala is good infrastructure -- the problem was ours.

## 8. Proof Cache for Instant Checkout

**Problem:** ZK proof generation takes ~2.2 seconds. That's too slow for a payment flow.

**Decision:** The buyer's agent pre-generates proofs in the background whenever receipts change. At checkout, the proof is a cache lookup -- 0ms. The `ProofCache` class handles invalidation when new receipts arrive and deduplicates in-flight proof generation.

## 9. Three-Agent to Two-Agent Architecture

**Original architecture:** Three cooperating agents -- buyer, TEE relay, merchant.

**Current architecture:** Two agents, one SDK:

1. **Buyer agent** -- installs `agora-protocol`, holds keys, stores receipts, generates loyalty proofs, discovers deals via 8004, executes payments in stealth or Railgun mode
2. **Merchant agent** -- publishes deals via 8004, generates stealth keys, scans for payments, issues receipts, verifies loyalty proofs

No middleware. No hosted infrastructure. The SDK handles stealth address derivation, payment planning, and (optionally) Railgun proof generation locally.

## 10. SDK Over Relay: The TEE Relay Was Privacy Theater

**Problem:** We built a TEE relay on Phala Cloud to abstract away Railgun complexity from buyer agents. The relay would run the Railgun engine inside Intel TDX, generate ZK proofs on the buyer's behalf, and submit transactions through the shielded pool.

**What we realized:** The relay had a fundamental design flaw. There were only two ways it could work:

1. **Custodial model:** The relay holds shielded funds on behalf of buyers. This makes the relay a mixer. Agents have to trust the relay with their money. The TEE attestation proves the code is correct, but the operator still controls the machine's uptime, networking, and key material lifecycle. It's "privacy" that requires trusting a third party -- the thing we were trying to eliminate.

2. **Non-custodial model:** Each buyer agent has their own Railgun wallet, and the relay just generates proofs. But if the agent already has a Railgun wallet initialized with shielded tokens, the relay is doing almost nothing -- the agent could generate the proof locally. The relay becomes an expensive proxy for two function calls.

Either way, the relay was wrong. Custodial = the privacy is theater. Non-custodial = the relay is pointless.

**Decision:** Pivot to an SDK with two payment modes:

- **Stealth mode (default):** Agent derives a stealth address from the merchant's meta-address. Sends ERC20 directly. Recipient privacy via ERC-5564. No Railgun needed. This is the low-friction path -- any agent with a wallet can do it.

- **Railgun mode (full privacy):** Agent initializes the Railgun engine locally. SDK calls `generateCrossContractCallsProof` + `populateProvedCrossContractCalls` from `@railgun-community/wallet`. Payment routes: Railgun shielded pool -> Relay Adapt contract -> stealth address. Full sender + recipient privacy.

The Railgun integration is real -- both functions are wired in `executor.ts`. The SDK generates the cross-contract calls proof, populates the proved transaction, and submits it. The relay code was deleted.

**Why this is better:**
- Stealth mode gives every agent recipient privacy with zero setup beyond a wallet
- Railgun mode gives full privacy for agents who want it, without trusting a third party
- No hosted infrastructure to maintain, pay for, or defend
- No custodial risk
- The agent controls its own keys and proof generation end-to-end

**The journey matters:** We didn't skip the hard part. We built the relay, deployed it to TDX, got it running, and then recognized it was architecturally wrong. The pivot to SDK-with-two-modes is a stronger design precisely because we understood why the relay failed.

## Technical Highlights

- **Circuit soundness fixes:** Three bugs caught during plan review -- unbound Merkle root, replayable nullifier (buyerSecret not in leaf hash), non-quadratic constraint in MerkleTreeChecker. All fixed before compilation.
- **Conditional time checks:** Padding slots (amount=0) are exempt from the `minTimestamp` constraint via `IsZero(amount) -> Mux1` -- allows zero-timestamp padding leaves when proving time-bounded spend.
- **B-point coordinate swap:** snarkjs stores G2 points as `[real, imag]` but the EVM BN128 precompile expects `[imag, real]`. Caught by Foundry test failure, fixed in `formatForSolidity`.
- **Zero-hash tree optimization:** Precomputed zero subtree hashes per level. Skips ~90% of Poseidon calls during tree construction. Tree build: ~300ms -> ~25ms.
- **63 verification assertions:** 21 TypeScript, 9 Foundry unit, 3 invariant fuzz (128k calls), 4 Halmos symbolic, 8 circuit negative, 20 E2E (stealth + on-chain + scanning). Down from 66 -- the 3 relay-specific E2E tests were removed with the relay.
