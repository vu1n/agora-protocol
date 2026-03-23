# Agora Threat Model

What the adversary learns, what they can't do, and where the boundaries are.

## Adversary Classes

| Adversary | Capabilities | Goal |
|-----------|-------------|------|
| **Malicious buyer** | Controls their own keys, receipts, proof inputs | Forge receipts, inflate loyalty spend, double-count purchases |
| **Malicious merchant** | Controls their EdDSA key, Merkle tree, receipt endpoint | Issue fake receipts, deny service, de-anonymize buyers |
| **Chain observer** | Reads all on-chain transactions and events | Link buyer identity to purchases, profile spending patterns |
| **Network observer** | Monitors HTTP traffic to receipt/intent endpoints | Correlate receipt fetches with payments, timing analysis |

---

## Threat 1: Receipt Spoofing

**Attack:** Buyer fabricates receipts to claim they spent more than they did.

### Without EdDSA (original design, 23k constraints)

Receipts were unsigned leaf hashes. A buyer who knew the Merkle tree structure could construct arbitrary receipts. **This was the #1 security issue identified during review.**

### With EdDSA (current design, 82k constraints)

Every receipt leaf hash is signed by the merchant's Baby Jubjub EdDSA key. The circuit verifies the signature in-circuit via `EdDSAPoseidonVerifier`. The merchant's public key is a public input, cross-checked on-chain against `MerchantRegistry.getEdDSAKey()`.

| Attack vector | Defense | Where enforced |
|--------------|---------|----------------|
| Forge a receipt signature | EdDSA is unforgeable under chosen-message attack | Circuit (EdDSAPoseidonVerifier) |
| Use your own EdDSA key to self-sign | Merchant pubkey cross-checked against on-chain registry | `LoyaltyManager.sol` line 74-75 |
| Replay a valid receipt from a different merchant | `scopeCommitment` binds receipts to a specific merchant/category | Circuit (leaf hash includes scopeCommitment) |
| Modify a signed receipt (change amount) | Signature is over the full leaf hash (all 5 fields) | Circuit (Poseidon hash → EdDSA verify) |

**Residual risk:** If a merchant's EdDSA private key is compromised, an attacker can forge receipts for that merchant. Mitigation: key rotation support (not yet implemented — `MerchantRegistry` currently has no key update function).

---

## Threat 2: Loyalty Proof Manipulation

**Attack:** Buyer inflates their proven spend to qualify for discounts they haven't earned.

### Double-counting receipts

A buyer includes the same receipt in multiple witness slots to multiply their spend (e.g., one $100 receipt in 5 slots → "proves" $500).

**Defense:** Pairwise `IsEqual` check on leaf indices for all active (non-padding) slot pairs. 28 comparisons for 8 slots. If two active slots share the same Merkle tree index, the circuit rejects.

```
bothActive[pairIdx] <== (1 - isZeroAmount[i].out) * (1 - isZeroAmount[j].out);
bothActive[pairIdx] * pairEq[pairIdx].out === 0;
```

### Proof replay

A buyer submits the same valid proof multiple times to claim a discount repeatedly.

**Defense:** Nullifier = `Poseidon(buyerSecret, merkleRoot)`. One proof per buyer per Merkle root version. `LoyaltyManager` stores used nullifiers and rejects duplicates.

**Note:** The nullifier is deterministic — same buyer + same root always produces the same nullifier. This means if the merchant doesn't update their root, the buyer can only prove once. When the merchant adds new purchases and updates the root, the buyer gets a fresh nullifier.

### Fake Merkle root

A buyer supplies a fabricated Merkle root containing fake receipts.

**Defense:** The Merkle root is a public input to the circuit. `LoyaltyManager` reads the root from `MerchantRegistry.getPurchaseRoot(scopeId)` and compares it against the proof's root. Callers cannot supply their own root.

### Cross-scope replay

A buyer uses a proof generated for merchant A to claim a discount at merchant B.

**Defense:** `scopeCommitment` is a public input verified in the circuit. The leaf hash includes `scopeCommitment`, binding each receipt to its scope. A proof for `hash(merchantA)` cannot satisfy a verifier expecting `hash(merchantB)`.

### Time window evasion

A buyer includes old receipts in a time-bounded proof.

**Defense:** `minTimestamp` is a public input. The circuit checks `purchaseTimestamp >= minTimestamp` for all non-padding slots via `GreaterEqThan(64)`. Padding slots (amount = 0) are exempt via `IsZero → Mux1`.

---

## Threat 3: Payment Spoofing

**Attack:** An adversary tricks a merchant into believing a payment was made when it wasn't, or manipulates payment parameters.

### Fake stealth payment

**Attack:** Attacker sends a transaction that looks like a stealth payment but sends to an address they control, then claims a receipt.

**Defense:** The merchant scans stealth address announcements using their viewing private key (`checkStealthAddress`). Only addresses derived from their stealth meta-address will match. An attacker cannot generate a valid stealth address for the merchant without the merchant's public spending key — and if they use the real public key, the derived address is controlled by the merchant, not the attacker.

### Underpayment

**Attack:** Buyer sends less than the agreed price to the stealth address.

**Defense:** The merchant detects the incoming amount when scanning. The receipt amount should reflect the actual amount received, not the deal price. This is an application-level check — the SDK plans the correct calldata via `planStealthPayment`, but the merchant should verify the received amount before issuing a receipt.

### Payment to wrong address

**Attack:** Man-in-the-middle replaces the merchant's stealth meta-address in the deal catalog with their own.

**Defense:** The deal catalog is fetched from the merchant's ERC-8004 agent card endpoint. If the merchant's hosting is compromised, the meta-address could be replaced. **Mitigation:** Merchants could publish a hash of their stealth meta-address on-chain (in `MerchantRegistry`) for buyers to verify. This is not currently implemented.

### Frontrunning proof submission

**Attack:** An observer sees a pending `verifySpendProof` transaction in the mempool and submits the same proof first, burning the nullifier.

**Defense:** Currently none — `verifySpendProof` has no access control on the caller. The legitimate buyer's transaction would revert with `NullifierAlreadyUsed`. The buyer would need to wait for a new Merkle root to generate a fresh proof.

**Mitigation options:**
- Add `msg.sender` or a buyer-specified address as a public input, so only the authorized submitter can use the proof
- Use a commit-reveal scheme
- Use Flashbots/private mempool for submission

**Severity:** Low in practice. The attacker gains nothing (the proof is anonymous — they can't claim the discount). They only grief the buyer.

---

## Threat 4: Purchase Privacy Attacks

**Attack:** Observer attempts to link a buyer's identity to their purchases or spending patterns.

### What the chain observer learns

| Mode | Observer learns | Observer does NOT learn |
|------|----------------|----------------------|
| **Stealth payment** | Sender address, amount, token, that a stealth address received funds | Which merchant received (stealth address is one-time, unlinkable) |
| **Railgun payment** | A Railgun transaction occurred, the Relay Adapt contract was called | Sender, recipient, amount (all shielded) |
| **Loyalty proof submission** | A proof was verified for scope X with threshold Y, a nullifier was consumed | Buyer identity, individual purchase amounts, purchase history |

### Stealth mode privacy boundaries

**Sender is visible.** In stealth mode, the buyer's wallet address is the `from` field on the ERC20 transfer. A chain observer can see which wallet paid. They cannot see *who received* because the stealth address is a one-time derived address.

**Amount is visible.** The ERC20 transfer amount is public. An observer who knows the merchant's prices could infer what was purchased.

**Timing correlation.** If a buyer pays via stealth mode and then immediately fetches a receipt from `GET /receipts/{ephPubKey}`, a network observer could correlate the payment and receipt fetch. **Mitigation:** The protocol design decouples receipt fetching from payment — buyers pull receipts when they need them for loyalty proofs, not at payment time.

### Railgun mode privacy boundaries

**Full sender + recipient privacy.** The Railgun shielded pool breaks the link between sender and stealth address. An observer sees a Railgun transaction but cannot determine sender, recipient, or amount.

**Anonymity set.** The buyer's anonymity set is the set of all Railgun users on the same network. A smaller Railgun user base means a smaller anonymity set.

### Nullifier linkability

**Can a merchant link proofs across root updates?** The nullifier is `Poseidon(buyerSecret, merkleRoot)`. When the merchant updates the root, the buyer produces a new nullifier. These nullifiers are **unlinkable** — different root → different nullifier. The merchant cannot determine if two proofs came from the same buyer across tree updates.

**Can a merchant link proofs within the same root?** No. Only one proof per buyer per root is possible (nullifier deduplication). A buyer who qualifies for a discount either proves once or not at all.

### Receipt endpoint timing

**Attack:** A network observer monitors `GET /receipts/{ephPubKey}` requests and correlates the ephemeral public key with a recent stealth address announcement.

**What leaks:** The ephemeral public key is public (it's announced on-chain as part of the stealth address protocol). Anyone can observe that *someone* fetched a receipt for a specific payment. They cannot decrypt the receipt (XChaCha20-Poly1305 with ECDH-derived key).

**Mitigation:** Buyers should fetch receipts at arbitrary times, not immediately after payment. The protocol supports this — receipts are stored by the merchant and pulled on demand.

### Stealth intent privacy

**Attack:** Observer monitors `agora-intent` service endpoints to profile buyer demand.

**What leaks:** The intent category and max price are public (they need to be for merchants to match). The buyer's identity is hidden behind a throwaway stealth address.

**What's protected:** The throwaway identity is funded from a stealth address (or via Railgun), registered as a fresh ERC-8004 identity, and abandoned after the transaction. There is no on-chain link between the throwaway identity and the buyer's real wallet.

**Residual risk:** If the throwaway address is funded via a direct transfer (not Railgun), the funding transaction links the buyer's real wallet to the throwaway. **Recommendation:** Fund throwaway identities via Railgun mode for full unlinkability.

---

## Trust Assumptions

| Assumption | What breaks if violated |
|-----------|----------------------|
| Merchant signs receipts honestly | Merchant could issue inflated receipts to favored buyers (but this hurts the merchant's own economics) |
| Merchant publishes correct Merkle root | Merchant could omit receipts from the tree, preventing buyers from proving loyalty |
| `MerchantRegistry` owner is the merchant | If the owner key is compromised, an attacker can update roots and deactivate the merchant |
| Circomlib EdDSA implementation is correct | All receipt verification breaks (mitigated by audited library + negative tests) |
| `@noble/curves` secp256k1 is correct | Stealth address derivation breaks (mitigated by audited, widely-used library) |
| Groth16 trusted setup is honest | Proof forgery becomes possible (mitigated by using Powers of Tau ceremony artifacts) |

---

## Known Limitations

1. **No key rotation.** `MerchantRegistry` does not support EdDSA key updates. A compromised key requires re-registration with a new agent ID.

2. **No receipt revocation.** If a purchase is refunded, the signed receipt remains valid. The buyer can still use it in loyalty proofs. A revocation scheme would require either a blacklist in the circuit or an updated Merkle root that excludes the revoked leaf.

3. **8-receipt limit per proof.** The circuit supports max 8 receipts per proof. A buyer with more than 8 qualifying purchases must select the 8 highest-value ones. This is a circuit size tradeoff (more slots = more EdDSA verifiers = larger circuit).

4. **Single Merkle root per proof.** Cross-merchant aggregation ("spent $500 across all coffee shops") requires proving against multiple merchants' trees. The current circuit takes a single `merkleRoot`. Cross-merchant proofs would require recursive proving or a shared category tree.

5. **64-bit comparators.** `GreaterEqThan(64)` supports amounts up to ~18.4 × 10^18 in smallest units. Sufficient for USDC (6 decimals, max ~$18.4 trillion) but could overflow for 18-decimal tokens at very large values.
