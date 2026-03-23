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

## 11. EdDSA Receipt Signing: Closing the Forgery Gap

**Problem:** Receipts were unsigned data blobs. A buyer who knew the Merkle tree structure could forge receipts and inflate their loyalty spend. The judge flagged this as the #1 security issue.

**Decision:** Add EdDSA Poseidon signature verification to the circuit. Each receipt leaf hash is signed by the merchant's Baby Jubjub key. The circuit verifies the signature (with `enabled=0` for padding slots). The merchant's public key is a public input, cross-checked on-chain against `MerchantRegistry`. Circuit grew from 23k to 82k constraints (8 EdDSA verifiers × ~7.5k each). Proof generation: ~2.2s → ~4-5s. The proof cache makes this invisible at checkout.

## 12. Leaf Uniqueness: Preventing Double-Counting

**Problem:** The same receipt could be included in multiple witness slots to inflate proven spend. A buyer with one $100 receipt could fill 5 slots to "prove" $500.

**Decision:** Pairwise `IsEqual` check on leaf indices for all active (non-padding) slot pairs. 28 comparisons for 8 slots. If both slots are active and have the same index, the circuit rejects. Padding slots (amount=0) are exempt so they can share indices.

## 13. On-Chain Proof Verification on Arbitrum Mainnet

**Problem:** The judge repeatedly flagged "zero on-chain usage" as a credibility gap. Deployed contracts with no transactions are dead code.

**Decision:** Registered a merchant with EdDSA public key on Arbitrum mainnet, published a Merkle root, and verified a real EdDSA-signed Groth16 proof. `verificationCount: 1`. Proof verification tx: `0x7c525dc1ba7e5cc511dd4d2be6ff6403792fbe095f81043af394a9d9ad920840` (326k gas).

## 14. Encrypted Receipt Delivery

**Problem:** How does the buyer get their receipt from the merchant? The receipt is needed for loyalty proofs but not at payment time.

**Decision:** Merchant serves encrypted receipts at `GET /receipts/{ephemeralPubKey}`. Encrypted with XChaCha20-Poly1305 (AEAD via `@noble/ciphers`). Key derived via ECDH with domain separation: `keccak256(shared || "agora-receipt")` — different from the stealth address key to prevent reuse. Tampered ciphertext throws. Wrong key throws. The buyer pulls when they want to prove loyalty, not at payment time. SDK exports `encryptReceipt` and `decryptReceipt` as helpers — the code IS the documentation for agents.

## 15. Stealth Intents: From Design to Mainnet

**Problem:** Anonymous buyer discovery was part of the architecture from the start (decision #5), but the implementation was deferred while the payment and loyalty layers were built first.

**Decision:** Implemented the full pipeline: `createThrowawayIdentity()` generates a stealth keypair and derives a one-time address, `buildIntentRegistration()` constructs an ERC-8004 registration payload with `agora-intent` service type, `discoverIntents()` lets merchants scan for buyer intents, `matchesIntent()` filters by category and price. Also built `createPrivateIntent()` which composes Railgun funding + throwaway identity + intent registration into a single call for fully anonymous buyer discovery.

Ran it live on Arbitrum — created a throwaway identity, derived a stealth address for a merchant, and executed a real USDC transfer. Merchant scanning confirmed payment detection. TX: `0x8670970e2ed36c93c65aa7223c31b1c3133591dd29f93f7df5c6c171bf73569f`.

## 16. Railgun Shield: Pushing Through the SDK Wall

**Problem:** The Railgun integration in `executor.ts` was structurally correct but never tested against the live Railgun engine. We wanted to prove the full privacy path worked end-to-end on mainnet, not just in mocked tests.

**What happened:** Multiple failed attempts before success. The Railgun Wallet SDK has sharp edges:

1. `level` (npm) doesn't satisfy Railgun's `AbstractLevelDOWN` requirement — had to switch to `leveldown`
2. `loadProvider` requires provider weight >= 2 for fallback quorum — undocumented, silent failure
3. The POI aggregator URL is `ppoi-agg.horsewithsixlegs.xyz` — found by reading the Railgun quickstart, not guessable
4. Public RPCs hang indefinitely on `loadProvider`'s batch contract reads — needed a dedicated RPC
5. Encryption key must be exactly 32 bytes hex with no `0x` prefix
6. `skipMerkletreeScans` must be false or wallet creation fails
7. Shield signature: `signMessage("RAILGUN_SHIELD")` returns 65 bytes but Railgun needs 32 — take the first 32

Each issue was a silent hang or a cryptic error. The SDK sanitizes errors so aggressively that `e.cause` is the only way to see the real failure.

**Decision:** Pushed through all seven. Successfully shielded USDC into the Railgun pool on Arbitrum mainnet. TX: `0xf192174bdb6c4fdda512e69710f9a0eb1948ce70056ba17c66b48aef44c6fbfc` (756k gas). Every gotcha is documented in `railgun-helper.ts` so the next developer or agent doesn't hit the same walls.

## 17. Composable LTV: Merchant-Defined Lifetime Value

**Problem:** The circuit takes a single `merkleRoot`, so cross-merchant aggregation ("I spent $500 across all coffee shops") isn't possible in a single proof. But a single aggregate number was never the right design — merchants need to define what LTV means to their business.

**Decision:** Merchants define their own LTV formula by requesting parallel proofs across categories they care about. A coffee shop requests `scopeCommitment=hash("coffee")` + `hash("brunch")` + `hash("breakfast")`, each with independent thresholds and time windows. The merchant composes the results into tiered discounts. No single proof needs to span multiple trees. Each merchant customizes their formula. More powerful than a single aggregate number — and it doesn't require recursive proofs or shared Merkle trees.

## 18. Formal Threat Model

**Problem:** Strong privacy claims need rigorous adversarial analysis. We wanted to document exactly what the system protects against, what it doesn't, and where the boundaries are.

**Decision:** Wrote `THREAT_MODEL.md` covering four adversary classes (malicious buyer, malicious merchant, chain observer, network observer) across four threat categories (receipt spoofing, loyalty proof manipulation, payment spoofing, purchase privacy attacks). Each attack vector maps to a specific defense with code-level references. Residual risks are explicitly flagged: frontrunning proof submission (low severity — attacker gains nothing), receipt endpoint timing correlation, throwaway identity funding linkability. Trust assumptions enumerated with failure consequences. Also implemented EdDSA key rotation in `MerchantRegistry.updateEdDSAKey()` with automatic root invalidation — directly closing the key compromise risk identified during the analysis.

## Technical Highlights

- **Circuit soundness fixes:** Three bugs caught during plan review — unbound Merkle root, replayable nullifier (buyerSecret not in leaf hash), non-quadratic constraint in MerkleTreeChecker. All fixed before compilation.
- **EdDSA upgrade:** Added EdDSAPoseidonVerifier per receipt slot with enabled flag for padding exemption. Circuit: 82,510 constraints. Merchant pubkey cross-checked on-chain.
- **Leaf uniqueness:** Pairwise IsEqual on leaf indices for active slots. 28 checks for n=8.
- **Conditional time checks:** Padding slots exempt from `minTimestamp` via `IsZero(amount) → Mux1`.
- **B-point coordinate swap:** snarkjs `[real, imag]` → EVM `[imag, real]`. Caught by Foundry test failure.
- **Zero-hash tree optimization:** Precomputed zero subtree hashes per level. Skips ~90% of Poseidon calls.
- **Receipt encryption:** XChaCha20-Poly1305 AEAD with domain-separated ECDH key. Reuses stealth address key exchange.
- **Proof cache:** Pre-generates proofs in background. 0ms at checkout. Invalidates on new receipts. Deduplicates in-flight generation.
- **Receipt server:** Reference Hono implementation with pluggable `ReceiptStore`. Encrypts on GET, not on store. 8 integration tests including adversarial decryption.
- **Railgun helper:** `initRailgun()` collapses ~30 lines of engine/wallet/provider setup to one call. Documents 7 SDK gotchas discovered during live mainnet testing.
- **Verification depth:** 63 TypeScript tests, 9 Foundry unit (real EdDSA proofs), 3 invariant fuzz (128k calls), 6 Halmos symbolic, 10 circuit tests (including EdDSA forgery), 20 E2E assertions, 3 on-chain Arbitrum mainnet transactions.
