import { buildPoseidon, type Poseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import path from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import type { MerchantReceipt, LoyaltyProofResult } from "./types.js";

const MERKLE_DEPTH = 10;
const MAX_PURCHASES = 8;
const TREE_SIZE = 1 << MERKLE_DEPTH;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = path.resolve(__dirname, "../circuits/build");
const WASM_PATH = path.join(CIRCUITS_DIR, "loyalty_verify_js/loyalty_verify.wasm");
const ZKEY_PATH = path.join(CIRCUITS_DIR, "loyalty_verify_final.zkey");
const VKEY_PATH = path.join(CIRCUITS_DIR, "verification_key.json");

export class AgoraProver {
  private poseidon!: Poseidon;
  private F!: any;

  async init() {
    this.poseidon = await buildPoseidon();
    this.F = this.poseidon.F;
  }

  hash(...inputs: bigint[]): bigint {
    return this.F.toObject(this.poseidon(inputs));
  }

  createReceipt(
    sellerCommitment: bigint,
    amount: bigint,
    buyerCommitment: bigint,
    salt: bigint,
  ): MerchantReceipt {
    return { sellerCommitment, amount, buyerCommitment, salt };
  }

  receiptLeaf(r: MerchantReceipt): bigint {
    return this.hash(r.sellerCommitment, r.amount, r.buyerCommitment, r.salt);
  }

  buildMerkleTree(receipts: MerchantReceipt[]): {
    root: bigint;
    layers: bigint[][];
  } {
    const zeroLeaf = this.hash(0n, 0n, 0n, 0n);
    const leaves: bigint[] = new Array(TREE_SIZE).fill(zeroLeaf);

    for (let i = 0; i < receipts.length; i++) {
      leaves[i] = this.receiptLeaf(receipts[i]);
    }

    const layers: bigint[][] = [leaves];
    let current = leaves;
    for (let d = 0; d < MERKLE_DEPTH; d++) {
      const next: bigint[] = [];
      for (let i = 0; i < current.length; i += 2) {
        next.push(this.hash(current[i], current[i + 1]));
      }
      layers.push(next);
      current = next;
    }

    return { root: layers[MERKLE_DEPTH][0], layers };
  }

  getMerkleProof(
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

  async proveLoyalty(params: {
    receipts: MerchantReceipt[];
    buyerSecret: bigint;
    sellerCommitment: bigint;
    threshold: bigint;
  }): Promise<LoyaltyProofResult> {
    const { receipts, buyerSecret, sellerCommitment, threshold } = params;

    if (receipts.length > MAX_PURCHASES)
      throw new Error(`Max ${MAX_PURCHASES} purchases per proof`);

    const buyerCommitment = this.hash(buyerSecret);

    // Build tree with real receipts + padding
    const allReceipts: MerchantReceipt[] = [...receipts];
    for (let i = receipts.length; i < MAX_PURCHASES; i++) {
      const paddingIdx = TREE_SIZE - 1 - (i - receipts.length);
      allReceipts.push({
        sellerCommitment,
        amount: 0n,
        buyerCommitment,
        salt: BigInt(2000 + i),
      });
    }

    // Place real receipts at indices 0..n-1, padding at end of tree
    const zeroLeaf = this.hash(0n, 0n, 0n, 0n);
    const leaves: bigint[] = new Array(TREE_SIZE).fill(zeroLeaf);
    for (let i = 0; i < receipts.length; i++) {
      leaves[i] = this.receiptLeaf(receipts[i]);
    }
    for (let i = receipts.length; i < MAX_PURCHASES; i++) {
      const paddingIdx = TREE_SIZE - 1 - (i - receipts.length);
      leaves[paddingIdx] = this.receiptLeaf(allReceipts[i]);
    }

    // Build full tree
    const layers: bigint[][] = [leaves];
    let current = leaves;
    for (let d = 0; d < MERKLE_DEPTH; d++) {
      const next: bigint[] = [];
      for (let i = 0; i < current.length; i += 2) {
        next.push(this.hash(current[i], current[i + 1]));
      }
      layers.push(next);
      current = next;
    }
    const merkleRoot = layers[MERKLE_DEPTH][0];

    // Build witness
    const purchaseAmounts: string[] = [];
    const purchaseSalts: string[] = [];
    const merklePaths: string[][] = [];
    const merkleIndices: string[][] = [];

    for (let i = 0; i < MAX_PURCHASES; i++) {
      purchaseAmounts.push(allReceipts[i].amount.toString());
      purchaseSalts.push(allReceipts[i].salt.toString());

      let leafIdx: number;
      if (i < receipts.length) {
        leafIdx = i;
      } else {
        leafIdx = TREE_SIZE - 1 - (i - receipts.length);
      }

      const proof = this.getMerkleProof(layers, leafIdx);
      merklePaths.push(proof.pathElements);
      merkleIndices.push(proof.pathIndices);
    }

    const witness = {
      purchaseAmounts,
      purchaseSalts,
      merklePaths,
      merkleIndices,
      buyerSecret: buyerSecret.toString(),
      merkleRoot: merkleRoot.toString(),
      sellerCommitment: sellerCommitment.toString(),
      threshold: threshold.toString(),
      purchaseCount: receipts.length.toString(),
    };

    // Generate proof
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      witness,
      WASM_PATH,
      ZKEY_PATH,
    );

    const nullifier = BigInt(publicSignals[0]);

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
      nullifier,
    };
  }

  /**
   * Format proof for Solidity verifyProof call.
   * Swaps B-point coordinates: snarkjs JSON is [real, imag] but EVM expects [imag, real].
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
      pubSignals: publicSignals.map(BigInt) as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ],
    };
  }

  async verifyLocally(result: LoyaltyProofResult): Promise<boolean> {
    const vkey = JSON.parse(readFileSync(VKEY_PATH, "utf-8"));
    return snarkjs.groth16.verify(
      vkey,
      result.publicSignals,
      {
        pi_a: [...result.proof.pi_a, "1"],
        pi_b: [...result.proof.pi_b.map((p) => [...p]), ["1", "0"]],
        pi_c: [...result.proof.pi_c, "1"],
        protocol: "groth16",
        curve: "bn128",
      },
    );
  }
}
