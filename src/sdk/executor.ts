/**
 * RailgunExecutor: handles the unshield → calls → reshield pipeline.
 *
 * Takes a RecipePlan (pure calldata) and executes it through Railgun's
 * privacy layer. Responsible for:
 *   - Verifying merchant root hasn't changed since planning
 *   - Wrapping calls in Railgun's Relay Adapt contract
 *   - Generating the Railgun ZK proof (shield/unshield)
 *   - Submitting the final transaction
 *
 * This module separates execution concerns from planning (recipe.ts).
 * The Recipe is pure; the Executor has side effects.
 */
import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  type Chain,
} from "viem";
import type { RecipePlan, AgoraSDKConfig } from "./types.js";

const registryAbi = parseAbi([
  "function getPurchaseRoot(bytes32 agentId) external view returns (bytes32)",
]);

export interface ExecutionResult {
  txHash: Hex;
  gasUsed: bigint;
  rootVerified: boolean;
}

export class RailgunExecutor {
  private config: AgoraSDKConfig;
  private client;

  constructor(config: AgoraSDKConfig) {
    this.config = config;
    this.client = createPublicClient({ transport: http(this.config.rpcUrl) });
  }

  /**
   * Verify that the merchant root hasn't changed since the recipe was planned.
   * Call this before submitting — a root change invalidates the ZK proof.
   */
  async verifyRootSnapshot(
    plan: RecipePlan,
  ): Promise<{ valid: boolean; currentRoot: Hex }> {
    if (!plan.merchantRootSnapshot) {
      return { valid: true, currentRoot: "0x" as Hex };
    }

    const currentRoot = (await this.client.readContract({
      address: this.config.contracts.registry,
      abi: registryAbi,
      functionName: "getPurchaseRoot",
      args: [plan.merchantRootSnapshot.scopeId],
    })) as Hex;

    return {
      valid: currentRoot === plan.merchantRootSnapshot.root,
      currentRoot,
    };
  }

  /**
   * Execute a recipe plan through Railgun.
   *
   * In production, this would:
   *   1. Verify root snapshot
   *   2. Call Railgun Wallet SDK to generate cross-contract call proof
   *   3. Submit via broadcaster (for full sender privacy) or directly
   *
   * For the hackathon, this demonstrates the interface. Full Railgun
   * Wallet SDK integration requires:
   *   - Initialized RailgunEngine with LevelDB
   *   - Downloaded proving artifacts (~100MB)
   *   - Merkle tree scan of on-chain events
   *   - PPOI validation
   *
   * The Recipe + Steps are complete and correct. This executor is the
   * integration boundary where Railgun SDK calls would be wired in.
   */
  async execute(plan: RecipePlan): Promise<ExecutionResult> {
    // 1. Verify root hasn't changed
    const rootCheck = await this.verifyRootSnapshot(plan);
    if (!rootCheck.valid) {
      throw new Error(
        `Merchant root changed since recipe was planned. ` +
        `Expected ${plan.merchantRootSnapshot?.root}, got ${rootCheck.currentRoot}. ` +
        `Re-plan the recipe with the current root.`,
      );
    }

    // 2. In production: wrap calls in Railgun unshield/reshield
    //
    // The Railgun Wallet SDK flow would be:
    //
    //   import { populateProvedCrossContractCalls } from '@railgun-community/wallet';
    //
    //   const crossContractCalls = plan.allCalls.map(c => ({
    //     to: c.to,
    //     data: c.data,
    //     value: c.value ?? 0n,
    //   }));
    //
    //   const { transaction } = await populateProvedCrossContractCalls(
    //     txidVersion,
    //     networkName,
    //     railgunWalletID,
    //     erc20AmountRecipients,      // unshield amounts
    //     [],                          // NFTs
    //     [],                          // relay adapt unshield
    //     [],                          // relay adapt shield
    //     crossContractCalls,          // our recipe's calls
    //     broadcasterFee,
    //     sendWithPublicWallet,
    //     overallBatchMinGasPrice,
    //     gasDetails,
    //   );
    //
    //   const txHash = await wallet.sendTransaction(transaction);

    throw new Error(
      "Full Railgun execution requires initialized RailgunEngine. " +
      "Use simulate() for local testing, or wire in the Wallet SDK for production.",
    );
  }

  /**
   * Simulate the recipe against a local fork or live RPC.
   * Dry-runs all calls sequentially to check for reverts before proving.
   */
  async simulate(
    plan: RecipePlan,
    fromAddress: Address,
  ): Promise<{ success: boolean; error?: string; gasEstimate?: bigint }> {
    const rootCheck = await this.verifyRootSnapshot(plan);
    if (!rootCheck.valid) {
      return {
        success: false,
        error: `Root changed: expected ${plan.merchantRootSnapshot?.root}, got ${rootCheck.currentRoot}`,
      };
    }

    // Simulate all calls in parallel
    const results = await Promise.allSettled(
      plan.allCalls.map(call =>
        this.client.estimateGas({
          account: fromAddress,
          to: call.to,
          data: call.data,
          value: call.value,
        }),
      ),
    );

    let totalGas = 0n;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "rejected") {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        return { success: false, error: `Call to ${plan.allCalls[i].to} reverted: ${msg}` };
      }
      totalGas += r.value;
    }

    return { success: true, gasEstimate: totalGas };
  }
}
