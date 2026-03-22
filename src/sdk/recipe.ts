/**
 * AgoraRecipe: client-side orchestration layer over Railgun.
 *
 * Generates typed call intents for a private payment + optional loyalty proof.
 * A separate RailgunExecutor handles the unshield → calls → reshield pipeline
 * and ZK proof generation.
 *
 * This is NOT a protocol primitive — it's a convenience layer that plans
 * what calls to make. Execution and privacy are handled by Railgun.
 */
import type { Address, Hex } from "viem";
import type {
  RecipePlan,
  CallIntent,
  TokenAmount,
  StepOutput,
  StealthMetaAddress,
  AgoraSDKConfig,
} from "./types.js";
import {
  planStealthPayment,
  type StealthPaymentResult,
} from "./steps/payment.js";
import { planLoyaltyProof } from "./steps/loyalty.js";
import type { LoyaltyProofResult } from "../types.js";
import type { AgoraProver } from "../prover.js";

export interface AgoraRecipeParams {
  /** ERC20 token to pay with */
  token: Address;
  /** Payment amount */
  amount: bigint;
  /** Merchant's stealth meta-address (for private delivery) */
  merchantMeta: StealthMetaAddress;
  /** Merchant/category scope ID (for registry root lookup) */
  scopeId: Hex;
  /** Current merchant root from on-chain registry (snapshot at planning time) */
  currentMerchantRoot: Hex;
  /** Pre-generated loyalty proof (optional — omit if not proving loyalty) */
  loyaltyProof?: LoyaltyProofResult;
}

export interface AgoraRecipeResult {
  plan: RecipePlan;
  /** The stealth address the merchant should scan for */
  stealthPayment: StealthPaymentResult;
}

/**
 * Plan a private payment with optional loyalty proof.
 *
 * Returns pure calldata — no side effects, no network calls.
 * The executor is responsible for:
 *   1. Verifying merchantRootSnapshot hasn't changed
 *   2. Wrapping calls in Railgun unshield/reshield
 *   3. Generating the Railgun ZK proof
 *   4. Submitting the transaction
 */
export function planAgoraRecipe(
  params: AgoraRecipeParams,
  config: AgoraSDKConfig,
  prover?: AgoraProver,
): AgoraRecipeResult {
  const {
    token,
    amount,
    merchantMeta,
    scopeId,
    currentMerchantRoot,
    loyaltyProof,
  } = params;

  const steps: StepOutput[] = [];
  const allCalls: CallIntent[] = [];
  const totalSpent: TokenAmount[] = [];

  // Step 1: Stealth payment
  const payment = planStealthPayment({ token, amount, merchantMeta });
  steps.push(payment.stepOutput);
  allCalls.push(...payment.stepOutput.calls);
  totalSpent.push(...payment.stepOutput.tokensSpent);

  // Step 2: Loyalty proof (optional)
  if (loyaltyProof) {
    if (!prover) throw new Error("prover is required when loyaltyProof is provided");
    const loyalty = planLoyaltyProof(
      { managerAddress: config.contracts.manager, proof: loyaltyProof, scopeId },
      prover,
    );
    steps.push(loyalty);
    allCalls.push(...loyalty.calls);
  }

  return {
    plan: {
      steps,
      allCalls,
      totalSpent,
      merchantRootSnapshot: { scopeId, root: currentMerchantRoot },
    },
    stealthPayment: payment,
  };
}
