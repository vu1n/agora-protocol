/**
 * Railgun engine convenience wrapper.
 *
 * Reduces Railgun init from ~30 lines of boilerplate to:
 *
 *   const railgun = await initRailgun({ rpcUrl, mnemonic, encryptionKey });
 *   const config = railgun.buildConfig(unshieldAmounts, gasDetails);
 *   await executor.executeRailgun(plan, config, walletClient);
 *
 * Gotchas discovered during live testing on Arbitrum:
 *   - Use `leveldown` (not `level`) — Railgun's engine expects AbstractLevelDOWN
 *   - Provider weight must be >= 2 for single-RPC fallback quorum
 *   - Set maxLogsPerBatch: 1 to avoid RPC batch limits
 *   - POI node URL: https://ppoi-agg.horsewithsixlegs.xyz
 *   - Encryption key must be exactly 32 bytes (64 hex chars, no 0x prefix)
 *   - skipMerkletreeScans must be false for wallet creation
 *   - Shield signature: sign "RAILGUN_SHIELD", take first 32 bytes as EC private key
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
  setLoggers,
  ArtifactStore,
} from "@railgun-community/wallet";
import {
  NetworkName,
  TXIDVersion,
  NETWORK_CONFIG,
  type RailgunWalletInfo,
  type RailgunERC20Amount,
  type TransactionGasDetails,
  type FallbackProviderJsonConfig,
} from "@railgun-community/shared-models";
import type { RailgunConfig } from "./executor.js";
import * as fs from "fs";
import * as path from "path";

// ── Types ──

export interface RailgunInitParams {
  /** RPC URL — use a dedicated provider (Alchemy, Moralis), not a public endpoint */
  rpcUrl: string;
  /** BIP-39 mnemonic for the Railgun wallet */
  mnemonic: string;
  /** Encryption key — exactly 32 bytes as hex string (64 chars, no 0x prefix) */
  encryptionKey: string;
  /** Network name (default: Arbitrum) */
  networkName?: NetworkName;
  /** Directory for artifacts and wallet DB (default: .railgun/) */
  dataDir?: string;
  /** Wallet derivation index (default: 0) */
  derivationIndex?: number;
  /** POI aggregator URL (default: public aggregator) */
  poiNodeURLs?: string[];
  /** Enable debug logging (default: false) */
  debug?: boolean;
}

export interface RailgunInstance {
  /** The Railgun wallet ID */
  walletID: string;
  /** The Railgun wallet info (includes railgunAddress) */
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
    async (p: string) => {
      const full = path.join(artifactDir, p);
      try { return await fs.promises.readFile(full); } catch { return null; }
    },
    async (dir: string, p: string, item: string | Uint8Array) => {
      await fs.promises.mkdir(path.join(artifactDir, dir), { recursive: true });
      await fs.promises.writeFile(path.join(artifactDir, p), item);
    },
    async (p: string) => {
      try { await fs.promises.access(path.join(artifactDir, p)); return true; } catch { return false; }
    },
  );
}

// ── LevelDB factory ──

async function createDB(dataDir: string) {
  // Must use `leveldown` (not `level`) — Railgun engine expects AbstractLevelDOWN
  const leveldown = (await import("leveldown")).default;
  const dbPath = path.join(dataDir, "db");
  fs.mkdirSync(dbPath, { recursive: true });
  return leveldown(dbPath);
}

// ── Main init function ──

/**
 * Initialize the Railgun engine, load a provider, and create a wallet.
 *
 * @example
 * ```ts
 * const railgun = await initRailgun({
 *   rpcUrl: "https://your-dedicated-rpc.com/arbitrum",
 *   mnemonic: "your twelve word mnemonic ...",
 *   encryptionKey: "0000000000000000000000000000000000000000000000000000000000000001",
 * });
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
    poiNodeURLs = ["https://ppoi-agg.horsewithsixlegs.xyz"],
    debug = false,
  } = params;

  // Validate encryption key length
  const keyBytes = encryptionKey.replace(/^0x/, "");
  if (keyBytes.length !== 64) {
    throw new Error(`encryptionKey must be 32 bytes (64 hex chars). Got ${keyBytes.length} chars.`);
  }

  fs.mkdirSync(dataDir, { recursive: true });

  // Debug logger
  if (debug) {
    setLoggers(
      (msg: any) => console.log(`  [railgun] ${msg}`),
      (err: any) => console.error(`  [railgun:err] ${err}`),
    );
  }

  // 1. Database + artifact store
  const db = await createDB(dataDir);
  const artifactStore = createFileArtifactStore(dataDir);

  // 2. Start engine
  // skipMerkletreeScans must be false — wallet creation requires scans
  await startRailgunEngine(
    "agora",
    db,
    debug,
    artifactStore,
    false,           // useNativeArtifacts (false for nodejs)
    false,           // skipMerkletreeScans — required for wallet creation
    poiNodeURLs,
  );

  // 3. Set callbacks after engine start (setting before throws)
  setOnUTXOMerkletreeScanCallback(() => {});
  setOnBalanceUpdateCallback(() => {});

  // 4. Load provider
  // weight >= 2 required for fallback quorum with single RPC
  // maxLogsPerBatch: 1 prevents RPC batch limits from causing hangs
  const chainId = NETWORK_CONFIG[networkName].chain.id;
  const fallbackConfig: FallbackProviderJsonConfig = {
    chainId,
    providers: [{
      provider: rpcUrl,
      priority: 3,
      weight: 2,
      maxLogsPerBatch: 1,
    }],
  };
  const pollingInterval = 1000 * 60 * 5; // 5 min per Railgun docs
  await loadProvider(fallbackConfig, networkName, pollingInterval);

  // 5. Create wallet
  const walletInfo = await createRailgunWallet(
    keyBytes,
    mnemonic,
    undefined,
    derivationIndex,
  );

  return createInstance(walletInfo, keyBytes, networkName);
}

/**
 * Load an existing Railgun wallet by ID (for subsequent runs).
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
    poiNodeURLs = ["https://ppoi-agg.horsewithsixlegs.xyz"],
    debug = false,
  } = params;

  const keyBytes = encryptionKey.replace(/^0x/, "");
  if (keyBytes.length !== 64) {
    throw new Error(`encryptionKey must be 32 bytes (64 hex chars). Got ${keyBytes.length} chars.`);
  }

  fs.mkdirSync(dataDir, { recursive: true });

  if (debug) {
    setLoggers(
      (msg: any) => console.log(`  [railgun] ${msg}`),
      (err: any) => console.error(`  [railgun:err] ${err}`),
    );
  }

  const db = await createDB(dataDir);
  const artifactStore = createFileArtifactStore(dataDir);

  await startRailgunEngine("agora", db, debug, artifactStore, false, false, poiNodeURLs);

  setOnUTXOMerkletreeScanCallback(() => {});
  setOnBalanceUpdateCallback(() => {});

  const chainId = NETWORK_CONFIG[networkName].chain.id;
  const fallbackConfig: FallbackProviderJsonConfig = {
    chainId,
    providers: [{ provider: rpcUrl, priority: 3, weight: 2, maxLogsPerBatch: 1 }],
  };
  await loadProvider(fallbackConfig, networkName, 1000 * 60 * 5);

  const walletInfo = await loadWalletByID(keyBytes, walletID, false);
  return createInstance(walletInfo, keyBytes, networkName);
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
        true,
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
