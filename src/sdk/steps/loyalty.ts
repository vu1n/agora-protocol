/**
 * LoyaltyProofStep: submits a ZK spend proof to the LoyaltyManager contract.
 *
 * This step is optional in the recipe — a buyer includes it when they want
 * to prove loyalty for a discount. The proof must be pre-generated (via ProofCache)
 * before planning the recipe.
 */
import { encodeFunctionData, type Address, type Hex } from "viem";
import type { CallIntent, StepOutput } from "../types.js";
import type { LoyaltyProofResult } from "../../types.js";
import { AgoraProver } from "../../prover.js";

const MANAGER_ABI = [
  {
    name: "verifySpendProof",
    type: "function",
    inputs: [
      { name: "a", type: "uint256[2]" },
      { name: "b", type: "uint256[2][2]" },
      { name: "c", type: "uint256[2]" },
      { name: "pubSignals", type: "uint256[8]" },
      { name: "scopeId", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface LoyaltyProofParams {
  managerAddress: Address;
  proof: LoyaltyProofResult;
  scopeId: Hex;
}

/**
 * Generate calldata for submitting a loyalty proof on-chain.
 * The proof must already be generated (this step is pure calldata, no proving).
 */
export function planLoyaltyProof(
  params: LoyaltyProofParams,
  prover: AgoraProver,
): StepOutput {
  const { managerAddress, proof, scopeId } = params;
  const sol = prover.formatForSolidity(proof);

  const call: CallIntent = {
    to: managerAddress,
    data: encodeFunctionData({
      abi: MANAGER_ABI,
      functionName: "verifySpendProof",
      args: [sol.a, sol.b, sol.c, sol.pubSignals, scopeId],
    }),
  };

  return {
    calls: [call],
    tokensSpent: [], // loyalty proof doesn't move tokens
    tokensProduced: [],
  };
}
