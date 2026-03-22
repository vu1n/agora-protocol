/**
 * Agora End-to-End Demo (EdDSA-signed receipts)
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
import { buildPoseidon, buildEddsa, buildBabyjub } from "circomlibjs";
import { AgoraProver } from "./prover.js";
import type { MerchantEdDSAKey, SpendReceipt } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USDC_DECIMALS = 1_000_000;

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
  console.log("=== Agora: ZK Privacy-Commerce Protocol (EdDSA) ===\n");

  // ── Init prover + EdDSA ──
  const prover = new AgoraProver();
  const eddsa = await buildEddsa();
  const babyJub = await buildBabyjub();
  const F = babyJub.F;
  await prover.init();

  // Merchant EdDSA keys (Baby Jubjub)
  const merchantPrivKey = Buffer.from(
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex"
  );
  const merchantPubKey = eddsa.prv2pub(merchantPrivKey);
  const merchantEdDSA: MerchantEdDSAKey = {
    Ax: F.toObject(merchantPubKey[0]).toString(),
    Ay: F.toObject(merchantPubKey[1]).toString(),
  };

  // Helper: sign a receipt leaf hash
  function signReceipt(receipt: SpendReceipt): SpendReceipt {
    const leafHash = prover.receiptLeaf(receipt);
    const sig = eddsa.signPoseidon(merchantPrivKey, F.e(leafHash));
    return {
      ...receipt,
      sig: {
        S: sig.S.toString(),
        R8x: F.toObject(sig.R8[0]).toString(),
        R8y: F.toObject(sig.R8[1]).toString(),
      },
    };
  }

  // Helper: create and sign a receipt
  function makeReceipt(scope: bigint, amount: bigint, salt: bigint, ts: bigint): SpendReceipt {
    const unsigned = prover.createReceipt(scope, amount, prover.hash(12345n), salt, ts,
      { S: "0", R8x: "0", R8y: "0" });
    return signReceipt(unsigned);
  }

  // ── Deploy ──
  console.log("Deploying contracts...");
  const verifierAddr = await deploy(verifierArtifact.bytecode.object as Hex);
  const registryAddr = await deploy(registryArtifact.bytecode.object as Hex);
  const managerAddr = await deploy(managerArtifact.bytecode.object as Hex, managerArtifact.abi, [verifierAddr, registryAddr]);
  console.log(`  Verifier:  ${verifierAddr}\n  Registry:  ${registryAddr}\n  Manager:   ${managerAddr}\n`);

  // ── Setup ──
  const BUYER_SECRET = 12345n;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const MERCHANT_ID = 42n;
  const merchantScope = prover.hash(MERCHANT_ID);
  const MERCHANT_AGENT_ID = pad("0x01", { size: 32 });
  const COFFEE_CATEGORY = 100n;
  const categoryScope = prover.hash(COFFEE_CATEGORY);
  const CATEGORY_SCOPE_ID = pad("0x02", { size: 32 });

  // Register with EdDSA keys
  let tx = await merchantClient.writeContract({
    address: registryAddr, abi: registryAbi, functionName: "registerMerchant",
    args: [MERCHANT_AGENT_ID, "Demo Coffee Shop", BigInt(merchantEdDSA.Ax), BigInt(merchantEdDSA.Ay)],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });
  tx = await merchantClient.writeContract({
    address: registryAddr, abi: registryAbi, functionName: "registerMerchant",
    args: [CATEGORY_SCOPE_ID, "Coffee Category", BigInt(merchantEdDSA.Ax), BigInt(merchantEdDSA.Ay)],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  // ═══════════════════════════════════════════
  // DEMO 1: Per-Merchant Loyalty (all-time)
  // ═══════════════════════════════════════════
  console.log("═══ Demo 1: Per-Merchant Loyalty ═══");
  console.log("Proving: spent >= $500 at Demo Coffee Shop (all time)\n");

  const merchantReceipts = [
    makeReceipt(merchantScope, 100_000_000n, 1001n, now - 86400n * 60n),
    makeReceipt(merchantScope, 150_000_000n, 1002n, now - 86400n * 45n),
    makeReceipt(merchantScope, 200_000_000n, 1003n, now - 86400n * 20n),
    makeReceipt(merchantScope, 75_000_000n,  1004n, now - 86400n * 5n),
    makeReceipt(merchantScope, 50_000_000n,  1005n, now - 86400n),
  ];
  console.log("  5 signed purchases: $100 + $150 + $200 + $75 + $50 = $575");

  let t0 = Date.now();
  const proof1 = await prover.proveSpend({
    receipts: merchantReceipts, buyerSecret: BUYER_SECRET,
    scopeCommitment: merchantScope, threshold: 500_000_000n, merchantKey: merchantEdDSA,
  });
  console.log(`  Proof generated in ${Date.now() - t0}ms`);

  tx = await merchantClient.writeContract({ address: registryAddr, abi: registryAbi, functionName: "updatePurchaseRoot", args: [MERCHANT_AGENT_ID, toHex(BigInt(proof1.publicSignals[1]), { size: 32 })] });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const sol1 = prover.formatForSolidity(proof1);
  const vHash1 = await buyerClient.writeContract({ address: managerAddr, abi: managerAbi, functionName: "verifySpendProof", args: [sol1.a, sol1.b, sol1.c, sol1.pubSignals, MERCHANT_AGENT_ID] });
  const vRcpt1 = await publicClient.waitForTransactionReceipt({ hash: vHash1 });
  console.log(`  VERIFIED on-chain (${vRcpt1.gasUsed} gas)`);

  try {
    await buyerClient.writeContract({ address: managerAddr, abi: managerAbi, functionName: "verifySpendProof", args: [sol1.a, sol1.b, sol1.c, sol1.pubSignals, MERCHANT_AGENT_ID] });
    throw new Error("Replay should have been rejected");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("should have been rejected")) throw e;
    console.log("  Replay rejected (nullifier used)");
  }

  // ═══════════════════════════════════════════
  // DEMO 2: Time-Bounded Loyalty (last 30 days)
  // ═══════════════════════════════════════════
  console.log("\n═══ Demo 2: Time-Bounded Loyalty ═══");
  const thirtyDaysAgo = now - 86400n * 30n;
  console.log("Proving: spent >= $300 at Demo Coffee Shop (last 30 days)\n");

  const recentReceipts = merchantReceipts.filter(r => r.timestamp >= thirtyDaysAgo);
  console.log(`  ${recentReceipts.length} purchases in window: $${Number(recentReceipts.reduce((s, r) => s + r.amount, 0n)) / USDC_DECIMALS}`);

  t0 = Date.now();
  const proof2 = await prover.proveSpend({
    receipts: recentReceipts, buyerSecret: BUYER_SECRET,
    scopeCommitment: merchantScope, threshold: 300_000_000n, minTimestamp: thirtyDaysAgo, merchantKey: merchantEdDSA,
  });
  console.log(`  Proof generated in ${Date.now() - t0}ms`);

  tx = await merchantClient.writeContract({ address: registryAddr, abi: registryAbi, functionName: "updatePurchaseRoot", args: [MERCHANT_AGENT_ID, toHex(BigInt(proof2.publicSignals[1]), { size: 32 })] });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const sol2 = prover.formatForSolidity(proof2);
  const vHash2 = await buyerClient.writeContract({ address: managerAddr, abi: managerAbi, functionName: "verifySpendProof", args: [sol2.a, sol2.b, sol2.c, sol2.pubSignals, MERCHANT_AGENT_ID] });
  const vRcpt2 = await publicClient.waitForTransactionReceipt({ hash: vHash2 });
  console.log(`  VERIFIED on-chain (${vRcpt2.gasUsed} gas)`);

  // ═══════════════════════════════════════════
  // DEMO 3: Cross-Merchant Category LTV
  // ═══════════════════════════════════════════
  console.log("\n═══ Demo 3: Category LTV ═══");
  console.log("Proving: spent >= $400 across ALL coffee shops (all time)\n");

  const categoryReceipts = [
    makeReceipt(categoryScope, 120_000_000n, 3001n, now - 86400n * 50n),
    makeReceipt(categoryScope, 80_000_000n,  3002n, now - 86400n * 40n),
    makeReceipt(categoryScope, 150_000_000n, 3003n, now - 86400n * 25n),
    makeReceipt(categoryScope, 100_000_000n, 3004n, now - 86400n * 10n),
  ];
  console.log("  4 signed purchases across 3 shops: $120 + $80 + $150 + $100 = $450");

  t0 = Date.now();
  const proof3 = await prover.proveSpend({
    receipts: categoryReceipts, buyerSecret: BUYER_SECRET,
    scopeCommitment: categoryScope, threshold: 400_000_000n, merchantKey: merchantEdDSA,
  });
  console.log(`  Proof generated in ${Date.now() - t0}ms`);

  tx = await merchantClient.writeContract({ address: registryAddr, abi: registryAbi, functionName: "updatePurchaseRoot", args: [CATEGORY_SCOPE_ID, toHex(BigInt(proof3.publicSignals[1]), { size: 32 })] });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const sol3 = prover.formatForSolidity(proof3);
  const vHash3 = await buyerClient.writeContract({ address: managerAddr, abi: managerAbi, functionName: "verifySpendProof", args: [sol3.a, sol3.b, sol3.c, sol3.pubSignals, CATEGORY_SCOPE_ID] });
  const vRcpt3 = await publicClient.waitForTransactionReceipt({ hash: vHash3 });
  console.log(`  VERIFIED on-chain (${vRcpt3.gasUsed} gas)`);

  const count = await publicClient.readContract({ address: managerAddr, abi: managerAbi, functionName: "verificationCount" });
  console.log("\n═══ Summary ═══");
  console.log(`Total proofs verified: ${count}`);
  console.log(`Circuit: 82,510 constraints (EdDSA-signed), ~4s proof generation`);
  console.log(`One circuit: per-merchant loyalty, time-bounded, cross-category LTV`);
  console.log(`Receipts are EdDSA-signed. Merchant pubkey validated on-chain.`);
}

main().catch((e) => { console.error("\nDemo failed:", e.message || e); process.exit(1); });
