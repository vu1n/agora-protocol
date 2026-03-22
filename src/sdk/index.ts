// Agora SDK — private commerce for AI agents
//
// Two payment modes:
//   Stealth (default): recipient privacy via ERC-5564 stealth addresses
//   Railgun (upgrade):  full sender+recipient privacy via shielded pool
//
// Both modes use the same recipe planner, contracts, and loyalty proofs.

export { planAgoraRecipe, type AgoraRecipeParams, type AgoraRecipeResult } from "./recipe.js";
export { planStealthPayment, type StealthPaymentParams } from "./steps/payment.js";
export { planLoyaltyProof, type LoyaltyProofParams } from "./steps/loyalty.js";
export { AgoraExecutor, type ExecutionResult, type RailgunConfig } from "./executor.js";
export { DealDiscovery, type Deal, type AgentRegistration } from "./bazaar.js";
export {
  deriveStealthAddress,
  checkStealthAddress,
  generateStealthKeys,
} from "./stealth.js";
export type {
  CallIntent,
  StepOutput,
  TokenAmount,
  RecipePlan,
  StealthMetaAddress,
  StealthAddressResult,
  AgoraSDKConfig,
} from "./types.js";
