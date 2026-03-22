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
