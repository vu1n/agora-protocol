/**
 * StealthPaymentStep: transfers ERC20 tokens to a merchant's stealth address.
 *
 * Pure calldata generation — no execution. The caller (or RailgunExecutor)
 * handles wrapping this in unshield/reshield.
 */
import {
  encodeFunctionData,
  type Address,
  type Hex,
  erc20Abi,
} from "viem";
import type { CallIntent, StepOutput, TokenAmount } from "../types.js";
import { deriveStealthAddress } from "../stealth.js";
import type { StealthMetaAddress, StealthAddressResult } from "../types.js";

export interface StealthPaymentParams {
  token: Address;
  amount: bigint;
  merchantMeta: StealthMetaAddress;
}

export interface StealthPaymentResult {
  stepOutput: StepOutput;
  stealth: StealthAddressResult;
}

/**
 * Generate calldata for a stealth payment.
 * Returns the call intents + the derived stealth address for the merchant to scan.
 */
export function planStealthPayment(
  params: StealthPaymentParams,
): StealthPaymentResult {
  const { token, amount, merchantMeta } = params;

  // Derive one-time stealth address for this payment
  const stealth = deriveStealthAddress(merchantMeta);

  // ERC20 transfer to stealth address
  const transferCall: CallIntent = {
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [stealth.stealthAddress, amount],
    }),
  };

  return {
    stepOutput: {
      calls: [transferCall],
      tokensSpent: [{ token, amount }],
      tokensProduced: [], // tokens leave the recipe (payment to merchant)
    },
    stealth,
  };
}
