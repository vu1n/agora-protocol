/**
 * Railgun engine convenience wrapper.
 *
 * Reduces Railgun init from ~30 lines of boilerplate to:
 *
 *   const railgun = await initRailgun({ rpcUrl, mnemonic, encryptionKey });
 *   const config = railgun.buildConfig(unshieldAmounts, gasDetails);
 *   await executor.executeRailgun(plan, config, walletClient);
 *
 * Handles: engine start, artifact storage, provider loading,
 * wallet creation, and balance scanning.
 */
import {
  startRailgunEngine,
  stopRailgunEngine,
  createRailgunWallet,
  loadWalletByID,
  loadProvider,
  setOnBalanceUpdateCallback,
  balanceForERC20Token,
  setOnUTXOMerkletreeScanCallback,
  walletForID,
  ArtifactStore,
} from "@railgun-community/wallet";
import {
  NetworkName,
  TXIDVersion,
  type RailgunWalletInfo,
  type RailgunERC20Amount,
  type TransactionGasDetails,
  type FallbackProviderJsonConfig,
  type Chain,
} from "@railgun-community/shared-models";
import type { AbstractLevelDOWN } from "abstract-leveldown";
import type { RailgunConfig } from "./executor.js";
import * as fs from "fs";
import * as path from "path";

// ── Types ──

export interface RailgunInitParams {
  /** Arbitrum RPC URL */
  rpcUrl: string;
  /** BIP-39 mnemonic for the Railgun wallet */
  mnemonic: string;
  /** Encryption key for wallet storage (any string, used to encrypt local DB) */
  encryptionKey: string;
  /** Network name (default: Arbitrum) */
  networkName?: NetworkName;
  /** Directory for storing artifacts and wallet DB (default: .railgun/) */
  dataDir?: string;
  /** Wallet derivation index (default: 0) */
  derivationIndex?: number;
  /** POI node URLs (required for Arbitrum/Polygon — default: public aggregator) */
  poiNodeURLs?: string[];
  /** Whether to skip merkletree scans (default: false) */
  skipScans?: boolean;
}

export interface RailgunInstance {
  /** The Railgun wallet ID */
  walletID: string;
  /** The Railgun wallet info */
  walletInfo: RailgunWalletInfo;
  /** Encryption key (needed for executor config) */
  encryptionKey: string;
  /** Network name */
  networkName: NetworkName;
  /** Check balance of an ERC20 token in the shielded wallet */
  getBalance(tokenAddress: string): Promise<bigint>;
  /** Build a RailgunConfig for the executor */
  buildConfig(
    unshieldERC20Amounts: RailgunERC20Amount[],
    gasDetails: TransactionGasDetails,
    opts?: { sendWithPublicWallet?: boolean },
  ): RailgunConfig;
  /** Shut down the engine cleanly */
  shutdown(): Promise<void>;
}

// ── File-based artifact store ──

function createFileArtifactStore(dataDir: string): ArtifactStore {
  const artifactDir = path.join(dataDir, "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });

  return new ArtifactStore(
    // get
    async (artifactPath: string) => {
      const fullPath = path.join(artifactDir, artifactPath);
      if (!fs.existsSync(fullPath)) return null;
      return fs.readFileSync(fullPath);
    },
    // store
    async (dir: string, artifactPath: string, item: string | Uint8Array) => {
      const fullDir = path.join(artifactDir, dir);
      fs.mkdirSync(fullDir, { recursive: true });
      const fullPath = path.join(artifactDir, artifactPath);
      fs.writeFileSync(fullPath, item);
    },
    // exists
    async (artifactPath: string) => {
      return fs.existsSync(path.join(artifactDir, artifactPath));
    },
  );
}

// ── LevelDB factory ──

async function createDB(dataDir: string): Promise<AbstractLevelDOWN> {
  const { Level } = await import("level");
  const dbPath = path.join(dataDir, "wallet-db");
  fs.mkdirSync(dbPath, { recursive: true });
  const db = new Level(dbPath);
  // Level v8+ wraps abstract-level; Railgun expects abstract-leveldown.
  // The underlying store is compatible.
  return db as unknown as AbstractLevelDOWN;
}

// ── Main init function ──

/**
 * Initialize the Railgun engine, load a provider, and create/load a wallet.
 *
 * This replaces ~30 lines of setup boilerplate with a single call.
 *
 * @example
 * ```ts
 * const railgun = await initRailgun({
 *   rpcUrl: "https://arb1.arbitrum.io/rpc",
 *   mnemonic: "your twelve word mnemonic ...",
 *   encryptionKey: "any-secret-string",
 * });
 *
 * const config = railgun.buildConfig(
 *   [{ tokenAddress: USDC, amount: 5000000n }],
 *   { maxFeePerGas: 100000000n, maxPriorityFeePerGas: 1n, gasLimit: 500000n },
 * );
 *
 * const result = await executor.executeRailgun(plan, config, walletClient);
 * ```
 */
export async function initRailgun(params: RailgunInitParams): Promise<RailgunInstance> {
  const {
    rpcUrl,
    mnemonic,
    encryptionKey,
    networkName = NetworkName.Arbitrum,
    dataDir = ".railgun",
    derivationIndex = 0,
    poiNodeURLs = ["https://poi-node.railgun.org"],
    skipScans = false,
  } = params;

  fs.mkdirSync(dataDir, { recursive: true });

  // 1. Create DB and artifact store
  const db = await createDB(dataDir);
  const artifactStore = createFileArtifactStore(dataDir);

  // 2. Set scan callbacks (no-op by default, prevents unhandled errors)
  setOnUTXOMerkletreeScanCallback(() => {});
  setOnBalanceUpdateCallback(() => {});

  // 3. Start engine
  await startRailgunEngine(
    "agora",          // walletSource (max 16 chars, lowercase)
    db,
    false,            // shouldDebug
    artifactStore,
    false,            // useNativeArtifacts (false for nodejs)
    skipScans,
    poiNodeURLs,
  );

  // 4. Load provider
  // Note: Railgun requires total provider weight >= 2 for fallback quorum.
  // With a single RPC, set weight=2. Public RPCs may timeout on the contract
  // calls loadProvider makes — use a dedicated RPC (Alchemy, Infura) for reliability.
  const fallbackConfig: FallbackProviderJsonConfig = {
    chainId: networkNameToChainId(networkName),
    providers: [{ provider: rpcUrl, priority: 1, weight: 2 }],
  };
  await loadProvider(fallbackConfig, networkName);

  // 5. Create or load wallet
  let walletInfo: RailgunWalletInfo;
  try {
    walletInfo = await createRailgunWallet(
      encryptionKey,
      mnemonic,
      undefined, // creationBlockNumbers — scan from latest
      derivationIndex,
    );
  } catch (e: any) {
    // Wallet may already exist in the DB from a previous run
    if (e.message?.includes("already loaded")) {
      // Re-throw — caller should use loadWalletByID for existing wallets
      throw new Error(
        "Wallet already exists in DB. Pass the walletID to loadExistingRailgunWallet() instead.",
      );
    }
    throw e;
  }

  return createInstance(walletInfo, encryptionKey, networkName);
}

/**
 * Load an existing Railgun wallet by ID (for subsequent runs after initial creation).
 */
export async function loadExistingRailgunWallet(
  params: Omit<RailgunInitParams, "mnemonic"> & { walletID: string },
): Promise<RailgunInstance> {
  const {
    rpcUrl,
    walletID,
    encryptionKey,
    networkName = NetworkName.Arbitrum,
    dataDir = ".railgun",
    poiNodeURLs = ["https://poi-node.railgun.org"],
    skipScans = false,
  } = params;

  fs.mkdirSync(dataDir, { recursive: true });

  const db = await createDB(dataDir);
  const artifactStore = createFileArtifactStore(dataDir);

  setOnUTXOMerkletreeScanCallback(() => {});
  setOnBalanceUpdateCallback(() => {});

  await startRailgunEngine("agora", db, false, artifactStore, false, skipScans, poiNodeURLs);

  const fallbackConfig: FallbackProviderJsonConfig = {
    chainId: networkNameToChainId(networkName),
    providers: [{ provider: rpcUrl, priority: 1, weight: 2 }],
  };
  await loadProvider(fallbackConfig, networkName);

  const walletInfo = await loadWalletByID(encryptionKey, walletID, false);
  return createInstance(walletInfo, encryptionKey, networkName);
}

// ── Internals ──

function createInstance(
  walletInfo: RailgunWalletInfo,
  encryptionKey: string,
  networkName: NetworkName,
): RailgunInstance {
  return {
    walletID: walletInfo.id,
    walletInfo,
    encryptionKey,
    networkName,

    async getBalance(tokenAddress: string): Promise<bigint> {
      const wallet = walletForID(walletInfo.id);
      return balanceForERC20Token(
        TXIDVersion.V2_PoseidonMerkle,
        wallet,
        networkName,
        tokenAddress,
        true, // onlySpendable
      );
    },

    buildConfig(
      unshieldERC20Amounts: RailgunERC20Amount[],
      gasDetails: TransactionGasDetails,
      opts?: { sendWithPublicWallet?: boolean },
    ): RailgunConfig {
      return {
        walletID: walletInfo.id,
        encryptionKey,
        networkName,
        unshieldERC20Amounts,
        gasDetails,
        sendWithPublicWallet: opts?.sendWithPublicWallet ?? false,
      };
    },

    async shutdown(): Promise<void> {
      await stopRailgunEngine();
    },
  };
}

function networkNameToChainId(networkName: NetworkName): number {
  const map: Partial<Record<NetworkName, number>> = {
    [NetworkName.Ethereum]: 1,
    [NetworkName.Arbitrum]: 42161,
    [NetworkName.Polygon]: 137,
    [NetworkName.BNBChain]: 56,
  };
  const id = map[networkName];
  if (!id) throw new Error(`Unsupported network: ${networkName}`);
  return id;
}
