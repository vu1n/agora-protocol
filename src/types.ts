export interface Groth16Proof {
  pi_a: [string, string];
  pi_b: [[string, string], [string, string]];
  pi_c: [string, string];
}

export interface MerchantReceipt {
  sellerCommitment: bigint;
  amount: bigint;
  buyerCommitment: bigint;
  salt: bigint;
}

export interface LoyaltyProofResult {
  proof: Groth16Proof;
  publicSignals: string[];
  nullifier: bigint;
}

export type LoyaltyTier = "bronze" | "silver" | "gold" | "platinum";

export interface LoyaltyTierConfig {
  tier: LoyaltyTier;
  minSpend: bigint;
  discountBps: number;
}

export const DEFAULT_TIERS: LoyaltyTierConfig[] = [
  { tier: "bronze", minSpend: 100_000_000n, discountBps: 200 },
  { tier: "silver", minSpend: 500_000_000n, discountBps: 500 },
  { tier: "gold", minSpend: 1_000_000_000n, discountBps: 1000 },
  { tier: "platinum", minSpend: 5_000_000_000n, discountBps: 1500 },
];

export function resolveTier(
  spend: bigint,
  tiers: LoyaltyTierConfig[] = DEFAULT_TIERS,
): LoyaltyTierConfig | null {
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (spend >= tiers[i].minSpend) return tiers[i];
  }
  return null;
}

export interface AgoraConfig {
  verifierAddress: `0x${string}`;
  registryAddress: `0x${string}`;
  managerAddress: `0x${string}`;
  rpcUrl: string;
  chainId: number;
}
