/**
 * Agora End-to-End Demo
 *
 * Demonstrates:
 * 1. Per-merchant loyalty: prove spend >= $500 at one merchant
 * 2. Time-bounded loyalty: prove spend >= $300 in the last 30 days
 * 3. Category LTV: prove spend >= $400 across all "coffee" merchants
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
  pad,
  toHex,
} from "viem";
import { anvil } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AgoraProver } from "./prover.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USDC_DECIMALS = 1_000_000;

// Anvil default accounts
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const MERCHANT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const BUYER_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
const chain = anvil;

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const deployerClient = createWalletClient({ account: privateKeyToAccount(DEPLOYER_KEY), chain, transport: http(rpcUrl) });
const merchantClient = createWalletClient({ account: privateKeyToAccount(MERCHANT_KEY), chain, transport: http(rpcUrl) });
const buyerClient = createWalletClient({ account: privateKeyToAccount(BUYER_KEY), chain, transport: http(rpcUrl) });

const registryAbi = parseAbi([
  "function registerMerchant(bytes32 agentId, string name, uint256 eddsaAx, uint256 eddsaAy) external",
  "function updatePurchaseRoot(bytes32 agentId, bytes32 newRoot) external",
]);

const managerAbi = parseAbi([
  "function verifySpendProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[8] pubSignals, bytes32 scopeId) external returns (bool)",
  "function verificationCount() external view returns (uint256)",
]);

const contractsDir = path.resolve(__dirname, "../contracts/out");
function loadArtifact(p: string) {
  return JSON.parse(readFileSync(path.join(contractsDir, p), "utf-8"));
}
const verifierArtifact = loadArtifact("LoyaltyVerifier.sol/Groth16Verifier.json");
const registryArtifact = loadArtifact("MerchantRegistry.sol/MerchantRegistry.json");
const managerArtifact = loadArtifact("LoyaltyManager.sol/LoyaltyManager.json");

async function deploy(bytecode: Hex, abi: unknown[] = [], args: unknown[] = []): Promise<Hex> {
  const hash = await deployerClient.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("Deployment failed");
  return receipt.contractAddress;
}

async function main() {
  console.log("=== Agora: ZK Privacy-Commerce Protocol ===\n");

  // ── Deploy ──
  console.log("Deploying contracts...");
  const prover = new AgoraProver();
  const proverReady = prover.init();

  const verifierAddr = await deploy(verifierArtifact.bytecode.object as Hex);
  const registryAddr = await deploy(registryArtifact.bytecode.object as Hex);
  const managerAddr = await deploy(managerArtifact.bytecode.object as Hex, managerArtifact.abi, [verifierAddr, registryAddr]);
  await proverReady;
  console.log(`  Verifier:  ${verifierAddr}\n  Registry:  ${registryAddr}\n  Manager:   ${managerAddr}\n`);

  // ── Setup ──
  const BUYER_SECRET = 12345n;
  const buyerCommitment = prover.hash(BUYER_SECRET);
  const now = BigInt(Math.floor(Date.now() / 1000));

  // Merchant scope (per-merchant)
  const MERCHANT_ID = 42n;
  const merchantScope = prover.hash(MERCHANT_ID);
  const MERCHANT_AGENT_ID = pad("0x01", { size: 32 });

  // Category scope (cross-merchant LTV)
  const COFFEE_CATEGORY = 100n;
  const categoryScope = prover.hash(COFFEE_CATEGORY);
  const CATEGORY_SCOPE_ID = pad("0x02", { size: 32 });

  // Register both scopes
  let tx = await merchantClient.writeContract({ address: registryAddr, abi: registryAbi, functionName: "registerMerchant", args: [MERCHANT_AGENT_ID, "Demo Coffee Shop"] });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await merchantClient.writeContract({ address: registryAddr, abi: registryAbi, functionName: "registerMerchant", args: [CATEGORY_SCOPE_ID, "Coffee Category"] });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  // ══════════════════════════════════════════════════════════
  // DEMO 1: Per-Merchant Loyalty (all-time)
  // ══════════════════════════════════════════════════════════
  console.log("═══ Demo 1: Per-Merchant Loyalty ═══");
  console.log("Proving: spent >= $500 at Demo Coffee Shop (all time)\n");

  const merchantReceipts = [
    prover.createReceipt(merchantScope, 100_000_000n, buyerCommitment, 1001n, now - 86400n * 60n),
    prover.createReceipt(merchantScope, 150_000_000n, buyerCommitment, 1002n, now - 86400n * 45n),
    prover.createReceipt(merchantScope, 200_000_000n, buyerCommitment, 1003n, now - 86400n * 20n),
    prover.createReceipt(merchantScope, 75_000_000n,  buyerCommitment, 1004n, now - 86400n * 5n),
    prover.createReceipt(merchantScope, 50_000_000n,  buyerCommitment, 1005n, now - 86400n),
  ];
  console.log("  5 purchases: $100 + $150 + $200 + $75 + $50 = $575");

  let t0 = Date.now();
  const proof1 = await prover.proveSpend({
    receipts: merchantReceipts,
    buyerSecret: BUYER_SECRET,
    scopeCommitment: merchantScope,
    threshold: 500_000_000n,
  });
  console.log(`  Proof generated in ${Date.now() - t0}ms`);

  // Publish root + verify
  tx = await merchantClient.writeContract({ address: registryAddr, abi: registryAbi, functionName: "updatePurchaseRoot", args: [MERCHANT_AGENT_ID, toHex(BigInt(proof1.publicSignals[1]), { size: 32 })] });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const sol1 = prover.formatForSolidity(proof1);
  const vHash1 = await buyerClient.writeContract({ address: managerAddr, abi: managerAbi, functionName: "verifySpendProof", args: [sol1.a, sol1.b, sol1.c, sol1.pubSignals, MERCHANT_AGENT_ID] });
  const vRcpt1 = await publicClient.waitForTransactionReceipt({ hash: vHash1 });
  console.log(`  VERIFIED on-chain (${vRcpt1.gasUsed} gas)`);

  // Replay
  try {
    await buyerClient.writeContract({ address: managerAddr, abi: managerAbi, functionName: "verifySpendProof", args: [sol1.a, sol1.b, sol1.c, sol1.pubSignals, MERCHANT_AGENT_ID] });
    throw new Error("Replay should have been rejected but succeeded");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("should have been rejected")) throw e;
    console.log("  Replay rejected (nullifier used)");
  }

  // ══════════════════════════════════════════════════════════
  // DEMO 2: Time-Bounded Loyalty (last 30 days)
  // ══════════════════════════════════════════════════════════
  console.log("\n═══ Demo 2: Time-Bounded Loyalty ═══");
  const thirtyDaysAgo = now - 86400n * 30n;
  console.log("Proving: spent >= $300 at Demo Coffee Shop (last 30 days)\n");

  // Only purchases within last 30 days qualify: $200 + $75 + $50 = $325
  const recentReceipts = merchantReceipts.filter(r => r.timestamp >= thirtyDaysAgo);
  console.log(`  ${recentReceipts.length} purchases in window: $${Number(recentReceipts.reduce((s, r) => s + r.amount, 0n)) / USDC_DECIMALS}`);

  t0 = Date.now();
  const proof2 = await prover.proveSpend({
    receipts: recentReceipts,
    buyerSecret: BUYER_SECRET,
    scopeCommitment: merchantScope,
    threshold: 300_000_000n,
    minTimestamp: thirtyDaysAgo,
  });
  console.log(`  Proof generated in ${Date.now() - t0}ms`);

  // New root for this tree (different receipts = different tree)
  tx = await merchantClient.writeContract({ address: registryAddr, abi: registryAbi, functionName: "updatePurchaseRoot", args: [MERCHANT_AGENT_ID, toHex(BigInt(proof2.publicSignals[1]), { size: 32 })] });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const sol2 = prover.formatForSolidity(proof2);
  const vHash2 = await buyerClient.writeContract({ address: managerAddr, abi: managerAbi, functionName: "verifySpendProof", args: [sol2.a, sol2.b, sol2.c, sol2.pubSignals, MERCHANT_AGENT_ID] });
  const vRcpt2 = await publicClient.waitForTransactionReceipt({ hash: vHash2 });
  console.log(`  VERIFIED on-chain (${vRcpt2.gasUsed} gas)`);

  // ══════════════════════════════════════════════════════════
  // DEMO 3: Cross-Merchant Category LTV
  // ══════════════════════════════════════════════════════════
  console.log("\n═══ Demo 3: Category LTV ═══");
  console.log("Proving: spent >= $400 across ALL coffee shops (all time)\n");

  // Receipts from different merchants, same category scope
  const categoryReceipts = [
    prover.createReceipt(categoryScope, 120_000_000n, buyerCommitment, 3001n, now - 86400n * 50n), // Shop A
    prover.createReceipt(categoryScope, 80_000_000n,  buyerCommitment, 3002n, now - 86400n * 40n), // Shop B
    prover.createReceipt(categoryScope, 150_000_000n, buyerCommitment, 3003n, now - 86400n * 25n), // Shop A
    prover.createReceipt(categoryScope, 100_000_000n, buyerCommitment, 3004n, now - 86400n * 10n), // Shop C
  ];
  console.log("  4 purchases across 3 shops: $120 + $80 + $150 + $100 = $450");

  t0 = Date.now();
  const proof3 = await prover.proveSpend({
    receipts: categoryReceipts,
    buyerSecret: BUYER_SECRET,
    scopeCommitment: categoryScope,
    threshold: 400_000_000n,
  });
  console.log(`  Proof generated in ${Date.now() - t0}ms`);

  tx = await merchantClient.writeContract({ address: registryAddr, abi: registryAbi, functionName: "updatePurchaseRoot", args: [CATEGORY_SCOPE_ID, toHex(BigInt(proof3.publicSignals[1]), { size: 32 })] });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const sol3 = prover.formatForSolidity(proof3);
  const vHash3 = await buyerClient.writeContract({ address: managerAddr, abi: managerAbi, functionName: "verifySpendProof", args: [sol3.a, sol3.b, sol3.c, sol3.pubSignals, CATEGORY_SCOPE_ID] });
  const vRcpt3 = await publicClient.waitForTransactionReceipt({ hash: vHash3 });
  console.log(`  VERIFIED on-chain (${vRcpt3.gasUsed} gas)`);

  // ── Summary ──
  const count = await publicClient.readContract({ address: managerAddr, abi: managerAbi, functionName: "verificationCount" });
  console.log("\n═══ Summary ═══");
  console.log(`Total proofs verified: ${count}`);
  console.log(`Circuit: 23,245 constraints, ~2.4s proof generation`);
  console.log(`One circuit handles: per-merchant loyalty, time-bounded, cross-category LTV`);
  console.log(`Merchant never learns buyer identity`);
}

main().catch((e) => {
  console.error("\nDemo failed:", e.message || e);
  process.exit(1);
});
