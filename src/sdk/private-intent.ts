/**
 * Private Intent: fully anonymous buyer discovery.
 *
 * Combines Railgun (sender privacy) + stealth intents (identity privacy)
 * into a single flow:
 *
 *   1. Create a throwaway stealth identity
 *   2. Fund it via Railgun shielded pool (sender unlinkable)
 *   3. Build the intent registration + payload
 *
 * The result: no one can link the intent to the buyer's real wallet.
 * The funding tx comes from Railgun (anonymous sender).
 * The intent is posted from a throwaway 8004 identity.
 * After transacting, the identity is discarded.
 *
 * Usage:
 *   const railgun = await initRailgun({ ... });
 *   const result = await createPrivateIntent(railgun, {
 *     category: "coffee",
 *     maxPrice: 10_000_000n,
 *     fundingToken: USDC,
 *     fundingAmount: 15_000_000n, // budget for the throwaway
 *   });
 *   // result.identity — throwaway keys
 *   // result.intent — the intent to publish
 *   // result.registration — 8004 registration payload
 *   // result.fundingConfig — RailgunConfig to fund the throwaway
 */
import type { Address, Hex, WalletClient } from "viem";
import { createThrowawayIdentity, buildIntentRegistration, buildIntentPayload, type StealthIntent, type ThrowawayIdentity } from "./intents.js";
import type { RailgunInstance } from "./railgun-helper.js";
import type { RailgunConfig } from "./executor.js";
import type { RailgunERC20Amount, TransactionGasDetails } from "@railgun-community/shared-models";

export interface PrivateIntentParams {
  /** What category to search for */
  category: string;
  /** Max price in smallest token unit (0 = no limit) */
  maxPrice: bigint;
  /** Token address to fund the throwaway identity with */
  fundingToken: Address;
  /** Amount to fund (budget for the throwaway — one transaction + gas) */
  fundingAmount: bigint;
  /** URL where the intent payload will be hosted */
  intentEndpoint: string;
  /** Optional tags for the intent */
  tags?: string[];
  /** Optional expiry (unix timestamp) */
  expiresAt?: number;
  /** Whether buyer can provide a ZK loyalty proof */
  loyaltyProofAvailable?: boolean;
}

export interface PrivateIntentResult {
  /** The throwaway identity (stealth address + keys) */
  identity: ThrowawayIdentity;
  /** The intent to publish at the intent endpoint */
  intent: StealthIntent;
  /** The intent payload (JSON-serializable for hosting) */
  payload: ReturnType<typeof buildIntentPayload>;
  /** The ERC-8004 registration payload for the throwaway identity */
  registration: ReturnType<typeof buildIntentRegistration>;
  /** RailgunConfig to fund the throwaway address via shielded pool */
  fundingConfig: RailgunConfig;
}

/**
 * Create a fully private intent: throwaway identity + Railgun funding config.
 *
 * After calling this:
 *   1. Execute the funding via `executor.executeRailgun(fundingPlan, result.fundingConfig, walletClient)`
 *   2. Host `result.payload` at `intentEndpoint`
 *   3. Register `result.registration` as an ERC-8004 agent from the throwaway address
 *   4. Merchants discover the intent, send offers to `result.intent.respondTo`
 *   5. Transact from the throwaway, then discard `result.identity`
 */
export function createPrivateIntent(
  railgun: RailgunInstance,
  params: PrivateIntentParams,
  gasDetails: TransactionGasDetails,
): PrivateIntentResult {
  // 1. Create throwaway identity
  const identity = createThrowawayIdentity();

  // 2. Build the intent
  const intent: StealthIntent = {
    category: params.category,
    maxPrice: params.maxPrice,
    loyaltyProofAvailable: params.loyaltyProofAvailable ?? false,
    respondTo: identity.address,
    tags: params.tags,
    expiresAt: params.expiresAt,
  };

  // 3. Build the 8004 registration and payload
  const registration = buildIntentRegistration(intent, params.intentEndpoint);
  const payload = buildIntentPayload(intent);

  // 4. Build funding config — Railgun unshields tokens to the throwaway address
  const unshieldERC20Amounts: RailgunERC20Amount[] = [
    {
      tokenAddress: params.fundingToken,
      amount: params.fundingAmount,
    },
  ];

  const fundingConfig = railgun.buildConfig(unshieldERC20Amounts, gasDetails, {
    sendWithPublicWallet: false, // use Railgun broadcaster for full privacy
  });

  return {
    identity,
    intent,
    payload,
    registration,
    fundingConfig,
  };
}
