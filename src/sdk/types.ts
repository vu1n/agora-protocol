import type { Hex, Address } from "viem";

/** A typed intent to call a contract. Pure data — no execution. */
export interface CallIntent {
  to: Address;
  data: Hex;
  value?: bigint;
}

/** Output of a Step: what it will spend, produce, and call. */
export interface StepOutput {
  calls: CallIntent[];
  tokensSpent: TokenAmount[];
  tokensProduced: TokenAmount[];
}

export interface TokenAmount {
  token: Address;
  amount: bigint;
}

/** Full recipe plan: ordered steps + metadata for simulation/execution. */
export interface RecipePlan {
  steps: StepOutput[];
  allCalls: CallIntent[];
  totalSpent: TokenAmount[];
  /** Merkle root snapshot — executor should verify this hasn't changed before submitting. */
  merchantRootSnapshot: { scopeId: Hex; root: Hex } | null;
}

/** Stealth meta-address: published by merchant, used by buyer to derive one-time addresses. */
export interface StealthMetaAddress {
  spendingPubKey: Hex;
  viewingPubKey: Hex;
}

/** Result of stealth address derivation. */
export interface StealthAddressResult {
  stealthAddress: Address;
  ephemeralPubKey: Hex;
  viewTag: number;
}

export interface AgoraSDKConfig {
  rpcUrl: string;
  chainId: number;
  contracts: {
    verifier: Address;
    registry: Address;
    manager: Address;
  };
}
