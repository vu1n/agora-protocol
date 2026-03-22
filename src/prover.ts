import { buildPoseidon, type Poseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import path from "path";
import { fileURLToPath } from "url";
import type { SpendReceipt, LoyaltyProofResult, MerchantEdDSAKey } from "./types.js";

const MERKLE_DEPTH = 10;
const MAX_PURCHASES = 8;
const TREE_SIZE = 1 << MERKLE_DEPTH;
const PADDING_SALT_BASE = 2000n;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = path.resolve(__dirname, "../circuits/build");
const WASM_PATH = path.join(CIRCUITS_DIR, "loyalty_verify_js/loyalty_verify.wasm");
const ZKEY_PATH = path.join(CIRCUITS_DIR, "loyalty_verify_final.zkey");

export class AgoraProver {
  private poseidon!: Poseidon;
  private F!: ReturnType<Poseidon["F"]>;
  private zeroLeaf!: bigint;
  private zeroHashes!: bigint[]; // precomputed zero subtree hashes per level
  private initialized = false;

  async init() {
    this.poseidon = await buildPoseidon();
    this.F = this.poseidon.F;
    this.initialized = true;

    this.zeroLeaf = this.hash(0n, 0n, 0n, 0n, 0n);

    // Precompute zero-hash table: zeroHashes[d] = hash of an all-zero subtree at depth d
    this.zeroHashes = new Array(MERKLE_DEPTH + 1);
    this.zeroHashes[0] = this.zeroLeaf;
    for (let d = 1; d <= MERKLE_DEPTH; d++) {
      this.zeroHashes[d] = this.hash(this.zeroHashes[d - 1], this.zeroHashes[d - 1]);
    }
  }

  private assertInit() {
    if (!this.initialized) throw new Error("AgoraProver.init() must be called before use");
  }

  hash(...inputs: bigint[]): bigint {
    this.assertInit();
    return this.F.toObject(this.poseidon(inputs));
  }

  createReceipt(
    scopeCommitment: bigint,
    amount: bigint,
    buyerCommitment: bigint,
    salt: bigint,
    timestamp: bigint,
    sig: { S: string; R8x: string; R8y: string },
  ): SpendReceipt {
    return { scopeCommitment, amount, buyerCommitment, salt, timestamp, sig };
  }

  receiptLeaf(r: SpendReceipt): bigint {
    return this.hash(r.scopeCommitment, r.amount, r.buyerCommitment, r.salt, r.timestamp);
  }

  /**
   * Build Merkle tree with zero-hash optimization.
   * Skips Poseidon calls for subtrees that are entirely zero leaves.
   */
  private buildTree(leaves: bigint[]): { root: bigint; layers: bigint[][] } {
    const layers: bigint[][] = [leaves];
    let current = leaves;

    for (let d = 0; d < MERKLE_DEPTH; d++) {
      const next: bigint[] = [];
      const zeroAtThisLevel = this.zeroHashes[d];
      const zeroParent = this.zeroHashes[d + 1];

      for (let i = 0; i < current.length; i += 2) {
        // If both children are the known zero-hash for this level, use precomputed parent
        if (current[i] === zeroAtThisLevel && current[i + 1] === zeroAtThisLevel) {
          next.push(zeroParent);
        } else {
          next.push(this.hash(current[i], current[i + 1]));
        }
      }

      layers.push(next);
      current = next;
    }

    return { root: layers[MERKLE_DEPTH][0], layers };
  }

  private getMerkleProof(
    layers: bigint[][],
    leafIndex: number,
  ): { pathElements: string[]; pathIndices: string[] } {
    const pathElements: string[] = [];
    const pathIndices: string[] = [];
    let idx = leafIndex;

    for (let d = 0; d < MERKLE_DEPTH; d++) {
      const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      pathElements.push(layers[d][siblingIdx].toString());
      pathIndices.push((idx % 2).toString());
      idx = Math.floor(idx / 2);
    }

    return { pathElements, pathIndices };
  }

  /**
   * Generate a ZK spend proof.
   *
   * @param receipts     Purchase receipts to prove (max 8)
   * @param buyerSecret  Buyer's private key for commitment + nullifier
   * @param scopeCommitment  Poseidon(sellerId) for loyalty, Poseidon(categoryId) for LTV
   * @param threshold    Minimum spend to prove
   * @param minTimestamp 0 for all-time, unix seconds for time-bounded
   */
  async proveSpend(params: {
    receipts: SpendReceipt[];
    buyerSecret: bigint;
    scopeCommitment: bigint;
    threshold: bigint;
    minTimestamp?: bigint;
    merchantKey: MerchantEdDSAKey;
  }): Promise<LoyaltyProofResult> {
    const { receipts, buyerSecret, scopeCommitment, threshold, minTimestamp = 0n, merchantKey } = params;

    if (receipts.length > MAX_PURCHASES)
      throw new Error(`Max ${MAX_PURCHASES} purchases per proof`);

    const buyerCommitment = this.hash(buyerSecret);

    // Build all receipts: real + zero-amount padding at tree end
    const allReceipts: SpendReceipt[] = [...receipts];
    for (let i = receipts.length; i < MAX_PURCHASES; i++) {
      allReceipts.push({
        scopeCommitment,
        amount: 0n,
        buyerCommitment,
        salt: PADDING_SALT_BASE + BigInt(i),
        timestamp: 0n,
        sig: { S: "0", R8x: "0", R8y: "0" }, // padding — EdDSA disabled via enabled=0
      });
    }

    // Place leaves: real at 0..n-1, padding at tree end
    const leaves: bigint[] = new Array(TREE_SIZE).fill(this.zeroLeaf);
    for (let i = 0; i < receipts.length; i++) {
      leaves[i] = this.receiptLeaf(receipts[i]);
    }
    for (let i = receipts.length; i < MAX_PURCHASES; i++) {
      leaves[TREE_SIZE - 1 - (i - receipts.length)] = this.receiptLeaf(allReceipts[i]);
    }

    const { root: merkleRoot, layers } = this.buildTree(leaves);

    // Build witness
    const purchaseAmounts: string[] = [];
    const purchaseSalts: string[] = [];
    const purchaseTimestamps: string[] = [];
    const merklePaths: string[][] = [];
    const merkleIndices: string[][] = [];
    const sigS: string[] = [];
    const sigR8x: string[] = [];
    const sigR8y: string[] = [];

    for (let i = 0; i < MAX_PURCHASES; i++) {
      purchaseAmounts.push(allReceipts[i].amount.toString());
      purchaseSalts.push(allReceipts[i].salt.toString());
      purchaseTimestamps.push(allReceipts[i].timestamp.toString());
      sigS.push(allReceipts[i].sig.S);
      sigR8x.push(allReceipts[i].sig.R8x);
      sigR8y.push(allReceipts[i].sig.R8y);

      const leafIdx = i < receipts.length
        ? i
        : TREE_SIZE - 1 - (i - receipts.length);

      const proof = this.getMerkleProof(layers, leafIdx);
      merklePaths.push(proof.pathElements);
      merkleIndices.push(proof.pathIndices);
    }

    const witness = {
      purchaseAmounts,
      purchaseSalts,
      purchaseTimestamps,
      merklePaths,
      merkleIndices,
      buyerSecret: buyerSecret.toString(),
      sigS,
      sigR8x,
      sigR8y,
      merkleRoot: merkleRoot.toString(),
      scopeCommitment: scopeCommitment.toString(),
      threshold: threshold.toString(),
      purchaseCount: receipts.length.toString(),
      minTimestamp: minTimestamp.toString(),
      merchantPubKeyAx: merchantKey.Ax,
      merchantPubKeyAy: merchantKey.Ay,
    };

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      witness,
      WASM_PATH,
      ZKEY_PATH,
    );

    return {
      proof: {
        pi_a: [proof.pi_a[0], proof.pi_a[1]],
        pi_b: [
          [proof.pi_b[0][0], proof.pi_b[0][1]],
          [proof.pi_b[1][0], proof.pi_b[1][1]],
        ],
        pi_c: [proof.pi_c[0], proof.pi_c[1]],
      },
      publicSignals,
      nullifier: BigInt(publicSignals[0]),
    };
  }

  /**
   * Swaps B-point coordinates for EVM: snarkjs stores [real, imag],
   * the BN128 pairing precompile expects [imag, real].
   */
  formatForSolidity(result: LoyaltyProofResult) {
    const { proof, publicSignals } = result;
    return {
      a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as const,
      b: [
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
      ] as const,
      c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as const,
      pubSignals: publicSignals.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint],
    };
  }
}
