import type { Address } from "viem";

export const CHAIN = {
  name: "arbitrum" as const,
  id: 42161,
  rpcUrl: process.env.ARBITRUM_RPC ?? "https://arb1.arbitrum.io/rpc",
};

export const CONTRACTS = {
  relayAdapt: "0xB4F2d77bD12c6b548Ae398244d7FAD4ABCE4D89b" as Address,
  railgunProxy: "0xFA7093CDD9EE6932B4eb2c9e1cde7CE00B1FA4b9" as Address,
  loyaltyManager: (process.env.LOYALTY_MANAGER_ADDRESS ?? "") as Address,
};

export const RELAY_VERSION = "0.1.0";
