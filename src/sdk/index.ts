// Agora SDK — client-side orchestration for private commerce
//
// Architecture:
//   Recipe (pure planning) → Executor (Railgun integration) → On-chain verification
//
// Control is split across layers:
//   - Railgun: privacy substrate (immutable contracts)
//   - Agora contracts: application logic (deployed, verifiable)
//   - This SDK: local planning (runs in agent's process, open source)

export { planAgoraRecipe, type AgoraRecipeParams, type AgoraRecipeResult } from "./recipe.js";
export { planStealthPayment, type StealthPaymentParams } from "./steps/payment.js";
export { planLoyaltyProof, type LoyaltyProofParams } from "./steps/loyalty.js";
export { RailgunExecutor, type ExecutionResult } from "./executor.js";
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
