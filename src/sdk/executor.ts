/**
 * AgoraExecutor: executes payment plans on-chain.
 *
 * Two modes:
 *   1. Stealth mode (default): agent sends directly to stealth address.
 *      Recipient privacy via ERC-5564. Sender is visible on-chain.
 *
 *   2. Railgun mode: agent routes through Railgun's shielded pool.
 *      Full sender + recipient privacy. Requires the agent to have
 *      initialized the Railgun engine via @railgun-community/wallet.
 *
 * Both modes use the same recipe planner, contracts, and loyalty proofs.
 */
import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import {
  generateCrossContractCallsProof,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import {
  TXIDVersion,
  NetworkName,
  type TransactionGasDetails,
  type RailgunERC20Amount,
  type RailgunERC20Recipient,
  type RailgunERC20AmountRecipient,
} from "@railgun-community/shared-models";
import type { ContractTransaction } from "ethers";
import type { RecipePlan, AgoraSDKConfig } from "./types.js";

const registryAbi = parseAbi([
  "function getPurchaseRoot(bytes32 agentId) external view returns (bytes32)",
]);

export interface ExecutionResult {
  txHashes: Hex[];
  totalGasUsed: bigint;
  mode: "stealth" | "railgun";
}

export interface RailgunConfig {
  walletID: string;
  encryptionKey: string;
  /** e.g. NetworkName.Arbitrum */
  networkName: NetworkName;
  /** Tokens to unshield for this transaction */
  unshieldERC20Amounts: RailgunERC20Amount[];
  /** Where to reshield leftover tokens */
  reshieldERC20Recipients?: RailgunERC20Recipient[];
  /** Gas details for the transaction */
  gasDetails: TransactionGasDetails;
  /** Broadcaster fee (optional — omit if submitting directly) */
  broadcasterFee?: RailgunERC20AmountRecipient;
  /** Set true if agent is paying gas from a public wallet */
  sendWithPublicWallet?: boolean;
}

export class AgoraExecutor {
  private config: AgoraSDKConfig;
  private publicClient;

  constructor(config: AgoraSDKConfig) {
    this.config = config;
    this.publicClient = createPublicClient({ transport: http(config.rpcUrl) });
  }

  /**
   * Verify that the merchant root hasn't changed since the recipe was planned.
   */
  async verifyRootSnapshot(
    plan: RecipePlan,
  ): Promise<{ valid: boolean; currentRoot: Hex }> {
    if (!plan.merchantRootSnapshot) {
      return { valid: true, currentRoot: "0x" as Hex };
    }

    const currentRoot = (await this.publicClient.readContract({
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
   * Execute in stealth mode: send directly to stealth addresses.
   * Provides recipient privacy. Sender is visible on-chain.
   */
  async executeStealth(
    plan: RecipePlan,
    walletClient: WalletClient,
  ): Promise<ExecutionResult> {
    const rootCheck = await this.verifyRootSnapshot(plan);
    if (!rootCheck.valid) {
      throw new Error(
        `Merchant root changed. Expected ${plan.merchantRootSnapshot?.root}, got ${rootCheck.currentRoot}.`,
      );
    }

    const txHashes: Hex[] = [];
    let totalGasUsed = 0n;

    for (const call of plan.allCalls) {
      const hash = await walletClient.sendTransaction({
        to: call.to,
        data: call.data,
        value: call.value,
        chain: walletClient.chain,
        account: walletClient.account!,
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      txHashes.push(hash);
      totalGasUsed += receipt.gasUsed;
    }

    return { txHashes, totalGasUsed, mode: "stealth" };
  }

  /**
   * Execute in Railgun mode: route through the shielded pool.
   * Full sender + recipient privacy.
   *
   * Prerequisites:
   *   - Agent has called startRailgunEngine() from @railgun-community/wallet
   *   - Agent has a Railgun wallet (createRailgunWallet or loadWalletByID)
   *   - Agent has shielded tokens in their Railgun balance
   *   - Agent has called loadProvider() with their Arbitrum RPC
   *
   * The plan's crossContractCalls are wrapped in:
   *   unshield → execute calls → reshield change
   */
  async executeRailgun(
    plan: RecipePlan,
    railgun: RailgunConfig,
    walletClient: WalletClient,
  ): Promise<ExecutionResult> {
    const rootCheck = await this.verifyRootSnapshot(plan);
    if (!rootCheck.valid) {
      throw new Error(
        `Merchant root changed. Expected ${plan.merchantRootSnapshot?.root}, got ${rootCheck.currentRoot}.`,
      );
    }

    // Convert our CallIntents to ethers ContractTransaction format
    const crossContractCalls: ContractTransaction[] = plan.allCalls.map(c => ({
      to: c.to,
      data: c.data,
      value: c.value ?? 0n,
    }));

    // Generate the Railgun ZK proof for cross-contract calls
    // This proves: "I own these shielded tokens, unshield them,
    // execute these calls, reshield the change"
    await generateCrossContractCallsProof(
      TXIDVersion.V2_PoseidonMerkle,
      railgun.networkName,
      railgun.walletID,
      railgun.encryptionKey,
      railgun.unshieldERC20Amounts,
      [],  // no NFTs
      railgun.reshieldERC20Recipients ?? [],
      [],  // no NFT reshield
      crossContractCalls,
      railgun.broadcasterFee ?? undefined,
      railgun.sendWithPublicWallet ?? false,
      0n,  // overallBatchMinGasPrice
      undefined,  // minGasLimit (use default)
      (progress) => {
        // Progress callback — agent can log this
      },
    );

    // Populate the proved transaction (uses cached proof from above)
    const { transaction } = await populateProvedCrossContractCalls(
      TXIDVersion.V2_PoseidonMerkle,
      railgun.networkName,
      railgun.walletID,
      railgun.unshieldERC20Amounts,
      [],  // no NFTs
      railgun.reshieldERC20Recipients ?? [],
      [],  // no NFT reshield
      crossContractCalls,
      railgun.broadcasterFee ?? undefined,
      railgun.sendWithPublicWallet ?? false,
      0n,  // overallBatchMinGasPrice
      railgun.gasDetails,
    );

    // Submit the transaction
    const hash = await walletClient.sendTransaction({
      to: transaction.to as Address,
      data: transaction.data as Hex,
      value: transaction.value ? BigInt(transaction.value.toString()) : undefined,
      gasLimit: transaction.gasLimit ? BigInt(transaction.gasLimit.toString()) : undefined,
      chain: walletClient.chain,
      account: walletClient.account!,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    return {
      txHashes: [hash],
      totalGasUsed: receipt.gasUsed,
      mode: "railgun",
    };
  }

  /**
   * Simulate the recipe against a live RPC (stealth mode).
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

    const results = await Promise.allSettled(
      plan.allCalls.map(call =>
        this.publicClient.estimateGas({
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
