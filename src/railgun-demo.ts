/**
 * Railgun Demo — attempt a shielded payment on Arbitrum mainnet.
 *
 * Steps:
 *   1. Initialize Railgun engine (download artifacts, create wallet)
 *   2. Shield USDC into the Railgun pool
 *   3. Wait for merkle tree scan to detect shielded balance
 *   4. Execute a cross-contract stealth payment through the shielded pool
 *
 * Usage:
 *   PRIVATE_KEY=0x... bun run src/railgun-demo.ts
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  type Hex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import {
  startRailgunEngine,
  createRailgunWallet,
  loadProvider,
  setOnBalanceUpdateCallback,
  setOnUTXOMerkletreeScanCallback,
  walletForID,
  balanceForERC20Token,
  getShieldPrivateKeySignatureMessage,
  populateShield,
} from "@railgun-community/wallet";
import { ArtifactStore } from "@railgun-community/wallet";
import {
  NetworkName,
  TXIDVersion,
  type RailgunERC20AmountRecipient,
} from "@railgun-community/shared-models";
import * as fs from "fs";
import * as path from "path";

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
const RPC = "https://arb1.arbitrum.io/rpc";
const SHIELD_AMOUNT = 100000n; // $0.10 USDC
const DATA_DIR = ".railgun-demo";

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

async function main() {
  const privKey = process.env.PRIVATE_KEY;
  if (!privKey) {
    console.error("Set PRIVATE_KEY env var");
    process.exit(1);
  }

  const account = privateKeyToAccount(privKey as Hex);
  const walletClient = createWalletClient({
    account,
    chain: arbitrum,
    transport: http(RPC),
  });
  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(RPC),
  });

  console.log("=== Agora Railgun Demo (Arbitrum Mainnet) ===\n");
  console.log(`Wallet: ${account.address}`);

  // Check balances
  const usdcBalance = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const ethBalance = await publicClient.getBalance({ address: account.address });
  console.log(`USDC: ${formatUnits(usdcBalance, 6)}`);
  console.log(`ETH:  ${formatUnits(ethBalance, 18)}`);

  if (usdcBalance < SHIELD_AMOUNT) {
    console.error(`Need ${formatUnits(SHIELD_AMOUNT, 6)} USDC, have ${formatUnits(usdcBalance, 6)}`);
    process.exit(1);
  }

  // ── Step 1: Initialize Railgun engine ──
  console.log("\n--- Step 1: Initialize Railgun engine ---");

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const artifactDir = path.join(DATA_DIR, "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });

  const artifactStore = new ArtifactStore(
    async (p: string) => {
      const full = path.join(artifactDir, p);
      if (!fs.existsSync(full)) return null;
      return fs.readFileSync(full);
    },
    async (dir: string, p: string, item: string | Uint8Array) => {
      const fullDir = path.join(artifactDir, dir);
      fs.mkdirSync(fullDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, p), item);
    },
    async (p: string) => fs.existsSync(path.join(artifactDir, p)),
  );

  // LevelDB for wallet state
  const { Level } = await import("level");
  const dbPath = path.join(DATA_DIR, "db");
  fs.mkdirSync(dbPath, { recursive: true });
  const db = new Level(dbPath) as any;

  console.log("Starting engine (downloading artifacts if needed)...");
  await startRailgunEngine(
    "agora",
    db,
    false,       // shouldDebug
    artifactStore,
    false,       // useNativeArtifacts (nodejs = false)
    true,        // skipMerkletreeScans — we'll trigger manually after shielding
    ["https://poi-node.railgun.org"],  // POI aggregator
  );
  console.log("Engine started.");

  let scanComplete = false;
  setOnUTXOMerkletreeScanCallback((scanData) => {
    console.log(`  Merkle scan: ${Math.round(scanData.progress * 100)}%`);
    if (scanData.progress >= 1) scanComplete = true;
  });
  setOnBalanceUpdateCallback(() => {
    console.log(`  Balance update received`);
  });

  // ── Step 2: Load provider ──
  console.log("\n--- Step 2: Load Arbitrum provider ---");
  try {
    const { createFallbackProviderFromJsonConfig } = await import("@railgun-community/shared-models");
    const config = {
      chainId: 42161,
      providers: [{ provider: RPC, priority: 1, weight: 2, stallTimeout: 10000 }],
    };
    console.log("Testing provider creation directly...");
    const fp = createFallbackProviderFromJsonConfig(config);
    console.log("FallbackProvider created:", !!fp);

    const providerResult = await loadProvider(config, NetworkName.Arbitrum, 15000);
    console.log("Provider loaded.", JSON.stringify(providerResult));
  } catch (e: any) {
    console.error("Provider load failed:", e.message);
    if (e.cause) console.error("Cause:", e.cause?.message ?? e.cause);
    // Try to get the real stack
    console.error("Stack:", e.stack?.split("\n").slice(0, 5).join("\n"));
    process.exit(1);
  }

  // ── Step 3: Create Railgun wallet ──
  console.log("\n--- Step 3: Create Railgun wallet ---");
  const mnemonic = "test test test test test test test test test test test junk";
  const encryptionKey = "agora-demo-key";

  let walletInfo;
  try {
    walletInfo = await createRailgunWallet(encryptionKey, mnemonic, undefined, 0);
    console.log(`Wallet created: ${walletInfo.id}`);
    console.log(`Railgun address: ${walletInfo.railgunAddress}`);
  } catch (e: any) {
    console.log(`Wallet already exists or error: ${e.message}`);
    process.exit(1);
  }

  // ── Step 4: Shield USDC ──
  console.log("\n--- Step 4: Shield USDC into Railgun pool ---");

  // Get the shield signature message
  const shieldSignatureMessage = getShieldPrivateKeySignatureMessage();
  console.log(`Signing shield message...`);

  // Sign it with our wallet
  const shieldSignature = await walletClient.signMessage({
    message: shieldSignatureMessage,
  });

  // Build the shield transaction
  const shieldERC20Recipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress: USDC,
      amount: SHIELD_AMOUNT,
      recipientAddress: walletInfo.railgunAddress!,
    },
  ];

  console.log(`Populating shield transaction for ${formatUnits(SHIELD_AMOUNT, 6)} USDC...`);

  const { transaction: shieldTx } = await populateShield(
    TXIDVersion.V2_PoseidonMerkle,
    NetworkName.Arbitrum,
    shieldSignature as Hex,
    shieldERC20Recipients,
    [], // no NFTs
  );

  // First approve the Railgun contract to spend our USDC
  console.log(`Approving Railgun contract...`);
  const approveTx = await walletClient.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "approve",
    args: [shieldTx.to as Address, SHIELD_AMOUNT],
  });
  const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
  console.log(`Approve confirmed: ${approveTx} (gas: ${approveReceipt.gasUsed})`);

  // Execute the shield
  console.log(`Executing shield transaction...`);
  const shieldHash = await walletClient.sendTransaction({
    to: shieldTx.to as Address,
    data: shieldTx.data as Hex,
    value: shieldTx.value ? BigInt(shieldTx.value.toString()) : 0n,
    chain: arbitrum,
    account: walletClient.account!,
  });

  const shieldReceipt = await publicClient.waitForTransactionReceipt({ hash: shieldHash });
  console.log(`Shield confirmed! TX: ${shieldHash}`);
  console.log(`Gas used: ${shieldReceipt.gasUsed}`);
  console.log(`Arbiscan: https://arbiscan.io/tx/${shieldHash}`);

  // ── Step 5: Check shielded balance ──
  console.log("\n--- Step 5: Check shielded balance ---");
  console.log("Waiting for merkle tree to update (this may take a moment)...");

  // Poll for balance
  let shieldedBalance = 0n;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const wallet = walletForID(walletInfo.id);
      shieldedBalance = await balanceForERC20Token(
        TXIDVersion.V2_PoseidonMerkle,
        wallet,
        NetworkName.Arbitrum,
        USDC,
        false, // not only spendable (include pending)
      );
      console.log(`  Shielded USDC balance: ${formatUnits(shieldedBalance, 6)}`);
      if (shieldedBalance > 0n) break;
    } catch (e: any) {
      console.log(`  Scan in progress... (${e.message?.slice(0, 50)})`);
    }
  }

  // ── Summary ──
  console.log("\n=== Summary ===");
  console.log(`Shield TX:        ${shieldHash}`);
  console.log(`Amount shielded:  ${formatUnits(SHIELD_AMOUNT, 6)} USDC`);
  console.log(`Shielded balance: ${formatUnits(shieldedBalance, 6)} USDC`);
  console.log(`\nOn-chain artifact: USDC shielded into Railgun pool on Arbitrum mainnet.`);

  if (shieldedBalance > 0n) {
    console.log(`\nShielded balance detected! A cross-contract stealth payment`);
    console.log(`could now be executed for full sender+recipient privacy.`);
  } else {
    console.log(`\nShielded balance not yet detected. The merkle tree scan`);
    console.log(`may need more time. The shield TX is confirmed on-chain.`);
  }
}

main().catch(console.error);
