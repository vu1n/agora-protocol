/**
 * Railgun Shield Demo — aligned with official docs.
 * https://docs.railgun.org/developer-guide/wallet/getting-started
 * https://docs.railgun.org/developer-guide/wallet/transactions/shielding
 *
 * Usage:
 *   PRIVATE_KEY=0x... ARBITRUM_RPC=https://... bun run src/railgun-demo.ts
 */
import {
  NETWORK_CONFIG,
  NetworkName,
  TXIDVersion,
  type RailgunERC20AmountRecipient,
  type FallbackProviderJsonConfig,
} from "@railgun-community/shared-models";
import {
  startRailgunEngine,
  loadProvider,
  createRailgunWallet,
  populateShield,
  setOnUTXOMerkletreeScanCallback,
  setOnBalanceUpdateCallback,
  setLoggers,
  ArtifactStore,
} from "@railgun-community/wallet";
import { Wallet, Contract, JsonRpcProvider } from "ethers";
import * as fs from "fs";
import * as path from "path";

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const DATA_DIR = ".railgun-demo";
const SHIELD_AMOUNT = 100000n; // $0.10 USDC

async function main() {
  const privKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.ARBITRUM_RPC;
  if (!privKey || !rpcUrl) {
    console.error("Set PRIVATE_KEY and ARBITRUM_RPC env vars");
    process.exit(1);
  }

  console.log("=== Railgun Shield Demo (Arbitrum) ===\n");

  // ── Step 7 (early): Debug logger ──
  setLoggers(
    (msg: any) => console.log(`  [engine] ${msg}`),
    (err: any) => console.error(`  [engine:err] ${err}`),
  );

  // ── Step 3: Database (leveldown for node) ──
  console.log("[1/6] Setting up database...");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const leveldown = (await import("leveldown")).default;
  const db = leveldown(path.join(DATA_DIR, "db"));

  // ── Step 4: Artifact store ──
  console.log("[2/6] Setting up artifact store...");
  const artifactsDir = path.join(DATA_DIR, "artifacts");
  const artifactStore = new ArtifactStore(
    async (p: string) => {
      const full = path.join(artifactsDir, p);
      try { return await fs.promises.readFile(full); } catch { return null; }
    },
    async (dir: string, p: string, item: string | Uint8Array) => {
      await fs.promises.mkdir(path.join(artifactsDir, dir), { recursive: true });
      await fs.promises.writeFile(path.join(artifactsDir, p), item);
    },
    async (p: string) => {
      try { await fs.promises.access(path.join(artifactsDir, p)); return true; } catch { return false; }
    },
  );

  // ── Step 5: Start engine ──
  console.log("[3/6] Starting engine...");
  await startRailgunEngine(
    "agora",             // walletSource (max 16 chars)
    db,                  // LevelDOWN database
    true,                // shouldDebug
    artifactStore,
    false,               // useNativeArtifacts (false for node)
    false,               // skipMerkletreeScans — required for wallet creation
    ["https://ppoi-agg.horsewithsixlegs.xyz"],
  );
  console.log("Engine started.\n");

  // ── Step 8: Load provider ──
  console.log("[4/6] Loading provider...");
  const providerConfig: FallbackProviderJsonConfig = {
    chainId: NETWORK_CONFIG[NetworkName.Arbitrum].chain.id,
    providers: [{
      provider: rpcUrl,
      priority: 3,
      weight: 2,
      maxLogsPerBatch: 1,
    }],
  };

  const pollingInterval = 1000 * 60 * 5;
  const providerPromise = loadProvider(providerConfig, NetworkName.Arbitrum, pollingInterval);
  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error("loadProvider timeout (5min)")), 300000),
  );

  try {
    const result = await Promise.race([providerPromise, timeout]);
    console.log("Provider loaded.\n");
  } catch (e: any) {
    console.error(`\nProvider failed: ${e.message}`);
    console.error("This usually means the RPC can't handle Railgun's batch contract reads.");
    process.exit(1);
  }

  // ── Create wallet ──
  console.log("[5/6] Creating wallet...");
  const mnemonic = "test test test test test test test test test test test junk";
  // Encryption key must be 32 bytes hex
  const encryptionKey = "0000000000000000000000000000000000000000000000000000000000000001";
  const walletInfo = await createRailgunWallet(encryptionKey, mnemonic, undefined, 0);
  console.log(`Railgun address: ${walletInfo.railgunAddress}\n`);

  // ── Shield USDC ──
  console.log("[6/6] Shielding USDC...");
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privKey, provider);

  const usdcContract = new Contract(USDC, [
    "function approve(address,uint256) returns (bool)",
    "function balanceOf(address) view returns (uint256)",
  ], wallet);

  const balance = await usdcContract.balanceOf(wallet.address);
  console.log(`USDC balance: ${balance}`);

  // Approve proxy
  const spender = NETWORK_CONFIG[NetworkName.Arbitrum].proxyContract;
  const approveTx = await usdcContract.approve(spender, SHIELD_AMOUNT);
  await approveTx.wait();
  console.log(`Approved: ${approveTx.hash}`);

  // Shield private key — sign canonical message, take first 32 bytes as EC private key
  const { getShieldPrivateKeySignatureMessage } = await import("@railgun-community/wallet");
  const shieldMsg = getShieldPrivateKeySignatureMessage();
  const shieldSig = await wallet.signMessage(shieldMsg);
  // Signature is 65 bytes; Railgun needs 32 bytes for an EC private key
  const shieldPrivateKey = shieldSig.slice(0, 66); // 0x + 64 hex chars = 32 bytes

  const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [{
    tokenAddress: USDC,
    amount: SHIELD_AMOUNT,
    recipientAddress: walletInfo.railgunAddress!,
  }];

  const { transaction } = await populateShield(
    TXIDVersion.V2_PoseidonMerkle,
    NetworkName.Arbitrum,
    shieldPrivateKey,
    erc20AmountRecipients,
    [],
  );

  const tx = await wallet.sendTransaction(transaction);
  console.log(`Shield TX: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed! Gas: ${receipt?.gasUsed}`);
  console.log(`https://arbiscan.io/tx/${tx.hash}`);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
