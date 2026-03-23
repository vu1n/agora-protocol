/**
 * Stealth Intent Demo — live on Arbitrum mainnet.
 *
 * Demonstrates the throwaway identity flow:
 *   1. Create a throwaway stealth identity
 *   2. Merchant generates stealth keys
 *   3. Derive a stealth payment address for the merchant
 *   4. Execute a real USDC transfer to the stealth address on Arbitrum
 *   5. Merchant scans and detects the payment
 *
 * This creates a real on-chain artifact: a stealth payment from a throwaway
 * identity to a merchant's one-time address on Arbitrum mainnet.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npx tsx src/stealth-intent-demo.ts
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
  createThrowawayIdentity,
  generateStealthKeys,
  deriveStealthAddress,
  checkStealthAddress,
  buildIntentPayload,
} from "./sdk/index.js";

// ── Config ──

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
const RPC = "https://arb1.arbitrum.io/rpc";
const PAYMENT_AMOUNT = 50000n; // $0.05 USDC (6 decimals)

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
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

  console.log("=== Agora Stealth Intent Demo (Arbitrum Mainnet) ===\n");
  console.log(`Buyer wallet: ${account.address}`);

  // Check USDC balance
  const balance = await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`USDC balance: ${formatUnits(balance, 6)} USDC`);

  if (balance < PAYMENT_AMOUNT) {
    console.error(`Insufficient USDC. Need ${formatUnits(PAYMENT_AMOUNT, 6)}, have ${formatUnits(balance, 6)}`);
    process.exit(1);
  }

  // ── Step 1: Create throwaway identity ──
  console.log("\n--- Step 1: Create throwaway identity ---");
  const throwaway = createThrowawayIdentity();
  console.log(`Throwaway address: ${throwaway.address}`);
  console.log(`Ephemeral pubkey:  ${throwaway.ephemeralPubKey.slice(0, 20)}...`);

  // ── Step 2: Build intent ──
  console.log("\n--- Step 2: Build anonymous intent ---");
  const intentPayload = buildIntentPayload({
    category: "coffee",
    maxPrice: 10_000_000n,
    loyaltyProofAvailable: false,
    respondTo: throwaway.address,
  });
  console.log(`Intent: ${JSON.stringify(intentPayload, null, 2)}`);

  // ── Step 3: Merchant generates stealth keys ──
  console.log("\n--- Step 3: Merchant generates stealth keys ---");
  const merchant = generateStealthKeys();
  console.log(`Merchant spending pubkey: ${merchant.meta.spendingPubKey.slice(0, 20)}...`);
  console.log(`Merchant viewing pubkey:  ${merchant.meta.viewingPubKey.slice(0, 20)}...`);

  // ── Step 4: Derive stealth payment address ──
  console.log("\n--- Step 4: Derive one-time stealth address ---");
  const stealth = deriveStealthAddress(merchant.meta);
  console.log(`Stealth address: ${stealth.stealthAddress}`);
  console.log(`View tag: ${stealth.viewTag}`);

  // ── Step 5: Execute stealth payment on Arbitrum ──
  console.log("\n--- Step 5: Execute stealth USDC payment on Arbitrum mainnet ---");
  console.log(`Sending ${formatUnits(PAYMENT_AMOUNT, 6)} USDC to stealth address...`);

  const txHash = await walletClient.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "transfer",
    args: [stealth.stealthAddress, PAYMENT_AMOUNT],
  });

  console.log(`TX submitted: ${txHash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`TX confirmed! Gas used: ${receipt.gasUsed}`);
  console.log(`Arbiscan: https://arbiscan.io/tx/${txHash}`);

  // ── Step 6: Merchant scans and detects payment ──
  console.log("\n--- Step 6: Merchant scans for payment ---");
  const scanResult = checkStealthAddress(
    stealth.ephemeralPubKey,
    stealth.viewTag,
    merchant.viewingPrivKey,
    merchant.meta.spendingPubKey,
  );

  if (scanResult.match) {
    console.log(`Payment detected at: ${scanResult.stealthAddress}`);

    // Verify the stealth address balance
    const stealthBalance = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [scanResult.stealthAddress!],
    });
    console.log(`Stealth address USDC balance: ${formatUnits(stealthBalance, 6)} USDC`);
  } else {
    console.error("ERROR: Merchant failed to detect payment!");
  }

  // ── Summary ──
  console.log("\n=== Summary ===");
  console.log(`Throwaway identity:  ${throwaway.address}`);
  console.log(`Stealth payment to:  ${stealth.stealthAddress}`);
  console.log(`Payment amount:      ${formatUnits(PAYMENT_AMOUNT, 6)} USDC`);
  console.log(`TX hash:             ${txHash}`);
  console.log(`Merchant detected:   ${scanResult.match}`);
  console.log(`\nOn-chain artifact: stealth USDC transfer on Arbitrum mainnet.`);
  console.log(`The stealth address is unlinkable to the merchant's real identity.`);
}

main().catch(console.error);
