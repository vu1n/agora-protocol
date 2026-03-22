export interface Groth16Proof {
  pi_a: [string, string];
  pi_b: [[string, string], [string, string]];
  pi_c: [string, string];
}

export interface SpendReceipt {
  scopeCommitment: bigint;  // Poseidon(sellerId) or Poseidon(categoryId)
  amount: bigint;
  buyerCommitment: bigint;
  salt: bigint;
  timestamp: bigint;        // unix seconds
  /** EdDSA signature over the leaf hash (Baby Jubjub / Poseidon) */
  sig: {
    S: string;
    R8x: string;
    R8y: string;
  };
}

/** Merchant's EdDSA public key (Baby Jubjub point) */
export interface MerchantEdDSAKey {
  Ax: string;
  Ay: string;
}

export interface LoyaltyProofResult {
  proof: Groth16Proof;
  publicSignals: string[];
  nullifier: bigint;
}

export interface AgoraConfig {
  verifierAddress: `0x${string}`;
  registryAddress: `0x${string}`;
  managerAddress: `0x${string}`;
  rpcUrl: string;
  chainId: number;
}
