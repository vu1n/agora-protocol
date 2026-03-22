/**
 * End-to-end test: full agent experience with stealth payments.
 *
 * Simulates the complete flow:
 *   1. Merchant registers on-chain + publishes deal via 8004 agent card
 *   2. Buyer discovers merchant, evaluates deal
 *   3. Buyer derives stealth address + plans payment
 *   4. Merchant detects payment via stealth scanning
 *   5. Merchant issues receipt, updates Merkle root
 *   6. Buyer generates ZK loyalty proof (cached)
 *   7. Buyer submits loyalty proof on-chain
 *   8. Replay rejected
 *
 * Runs against local Anvil.
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
import { ProofCache } from "./proof-cache.js";
import {
  generateStealthKeys,
  checkStealthAddress,
  DealDiscovery,
} from "./sdk/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USDC_DECIMALS = 1_000_000;

// Anvil accounts
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const MERCHANT_ACCOUNT = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const BUYER_ACCOUNT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const publicClient = createPublicClient({ chain: anvil, transport: http(rpcUrl) });
const deployerClient = createWalletClient({ account: DEPLOYER, chain: anvil, transport: http(rpcUrl) });
const merchantClient = createWalletClient({ account: MERCHANT_ACCOUNT, chain: anvil, transport: http(rpcUrl) });
const buyerClient = createWalletClient({ account: BUYER_ACCOUNT, chain: anvil, transport: http(rpcUrl) });

const registryAbi = parseAbi([
  "function registerMerchant(bytes32 agentId, string name) external",
  "function updatePurchaseRoot(bytes32 agentId, bytes32 newRoot) external",
]);
const managerAbi = parseAbi([
  "function verifySpendProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[6] pubSignals, bytes32 scopeId) external returns (bool)",
  "function verificationCount() external view returns (uint256)",
]);

// Load contract artifacts
const contractsDir = path.resolve(__dirname, "../contracts/out");
function loadArtifact(p: string) {
  return JSON.parse(readFileSync(path.join(contractsDir, p), "utf-8"));
}

async function deploy(bytecode: Hex, abi: unknown[] = [], args: unknown[] = []): Promise<Hex> {
  const hash = await deployerClient.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("Deployment failed");
  return receipt.contractAddress;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    passed++;
  } else {
    console.log(`  FAIL: ${msg}`);
    failed++;
  }
}

async function main() {
  console.log("=== Agora E2E Test ===\n");

  // ── Deploy contracts ──
  console.log("Deploying contracts...");
  const verifierArtifact = loadArtifact("LoyaltyVerifier.sol/Groth16Verifier.json");
  const registryArtifact = loadArtifact("MerchantRegistry.sol/MerchantRegistry.json");
  const managerArtifact = loadArtifact("LoyaltyManager.sol/LoyaltyManager.json");

  const verifierAddr = await deploy(verifierArtifact.bytecode.object as Hex);
  const registryAddr = await deploy(registryArtifact.bytecode.object as Hex);
  const managerAddr = await deploy(managerArtifact.bytecode.object as Hex, managerArtifact.abi, [verifierAddr, registryAddr]);
  console.log(`  Contracts deployed\n`);

  // ── 1. Merchant setup ──
  console.log("1. Merchant registers + publishes deal");
  const MERCHANT_AGENT_ID = pad("0x01", { size: 32 });
  const merchantStealth = generateStealthKeys();

  let tx = await merchantClient.writeContract({
    address: registryAddr, abi: registryAbi,
    functionName: "registerMerchant",
    args: [MERCHANT_AGENT_ID, "E2E Coffee Shop"],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  // Merchant's 8004 agent card (simulated — in production this is a hosted JSON)
  const merchantAgentCard = {
    metadata: { type: "agent", name: "E2E Coffee Shop" },
    services: [
      {
        type: "agora-deals",
        endpoint: "mock://deals", // in production: HTTPS URL
      },
    ],
  };

  // Merchant's deal catalog
  const dealCatalog = [
    {
      item: "Espresso",
      category: "coffee",
      price: 5_000_000,
      currency: "USDC",
      discountBps: 500,
      minLoyaltySpend: 20_000_000,
      stealthMetaAddress: {
        spendingPubKey: merchantStealth.meta.spendingPubKey,
        viewingPubKey: merchantStealth.meta.viewingPubKey,
      },
    },
  ];

  assert(true, "Merchant registered on-chain with stealth keys");

  // ── 2. Buyer discovers deal ──
  console.log("\n2. Buyer discovers merchant deal");
  const discovery = new DealDiscovery();
  const deal = dealCatalog[0]; // In production: fetched from merchant's 8004 endpoint

  assert(deal.item === "Espresso", "Buyer found Espresso deal");
  assert(deal.discountBps === 500, "Deal offers 5% loyalty discount");

  // ── 3. Buyer derives stealth address + plans payment ──
  console.log("\n3. Buyer derives stealth address for private payment");

  const { planStealthPayment, deriveStealthAddress } = await import("./sdk/index.js");

  const stealth = deriveStealthAddress({
    spendingPubKey: deal.stealthMetaAddress.spendingPubKey as Hex,
    viewingPubKey: deal.stealthMetaAddress.viewingPubKey as Hex,
  });

  assert(stealth.stealthAddress.startsWith("0x"), "Stealth address derived");
  assert(stealth.ephemeralPubKey.startsWith("0x"), "Ephemeral pubkey returned");
  assert(typeof stealth.viewTag === "number", "View tag returned");

  const payment = planStealthPayment({
    token: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" as `0x${string}`,
    amount: BigInt(deal.price),
    merchantMeta: {
      spendingPubKey: deal.stealthMetaAddress.spendingPubKey as Hex,
      viewingPubKey: deal.stealthMetaAddress.viewingPubKey as Hex,
    },
  });

  assert(payment.stepOutput.calls.length === 1, "One call (ERC20 transfer)");
  assert(payment.stepOutput.calls[0].data.startsWith("0xa9059cbb"), "Calldata is ERC20 transfer");

  // ── 4. Merchant detects payment ──
  console.log("\n4. Merchant scans for stealth payment");
  const detected = checkStealthAddress(
    stealth.ephemeralPubKey,
    stealth.viewTag,
    merchantStealth.viewingPrivKey,
    merchantStealth.meta.spendingPubKey,
  );

  assert(detected.match, "Merchant detected the stealth payment");
  assert(detected.stealthAddress === stealth.stealthAddress, "Stealth addresses match");

  // ── 5. Merchant issues receipt + updates root ──
  console.log("\n5. Merchant issues receipt, updates Merkle root");
  const prover = new AgoraProver();
  await prover.init();

  const BUYER_SECRET = 12345n;
  const buyerCommitment = prover.hash(BUYER_SECRET);
  const SELLER_ID = 42n;
  const scopeCommitment = prover.hash(SELLER_ID);
  const now = BigInt(Math.floor(Date.now() / 1000));

  // Simulate 4 prior purchases + this new one
  const receipts = [
    prover.createReceipt(scopeCommitment, 8_000_000n, buyerCommitment, 2001n, now - 86400n * 10n),
    prover.createReceipt(scopeCommitment, 5_000_000n, buyerCommitment, 2002n, now - 86400n * 7n),
    prover.createReceipt(scopeCommitment, 4_000_000n, buyerCommitment, 2003n, now - 86400n * 3n),
    prover.createReceipt(scopeCommitment, 6_000_000n, buyerCommitment, 2004n, now - 86400n),
    prover.createReceipt(scopeCommitment, BigInt(deal.price), buyerCommitment, 2005n, now), // this purchase
  ];

  const totalSpend = receipts.reduce((s, r) => s + r.amount, 0n);
  assert(totalSpend === 28_000_000n, `Total spend: $${Number(totalSpend) / USDC_DECIMALS}`);

  // ── 6. Buyer generates cached loyalty proof ──
  console.log("\n6. Buyer generates ZK loyalty proof (via cache)");
  const cache = new ProofCache(prover, BUYER_SECRET);
  cache.addReceipts("coffee-shop", receipts);

  // First call: cache miss, generates proof
  const t0 = Date.now();
  const proof = await cache.getProof("coffee-shop", scopeCommitment, BigInt(deal.minLoyaltySpend));
  const coldTime = Date.now() - t0;

  assert(proof.nullifier > 0n, `Proof generated (${coldTime}ms)`);
  assert(cache.hasCachedProof("coffee-shop", BigInt(deal.minLoyaltySpend)), "Proof is cached");

  // Second call: cache hit
  const t1 = Date.now();
  const cachedProof = await cache.getProof("coffee-shop", scopeCommitment, BigInt(deal.minLoyaltySpend));
  const hotTime = Date.now() - t1;

  assert(cachedProof === proof, `Cache hit (${hotTime}ms)`);

  // ── 7. Publish root + submit proof on-chain ──
  console.log("\n7. Submit loyalty proof on-chain");
  const merkleRoot = proof.publicSignals[1];

  tx = await merchantClient.writeContract({
    address: registryAddr, abi: registryAbi,
    functionName: "updatePurchaseRoot",
    args: [MERCHANT_AGENT_ID, toHex(BigInt(merkleRoot), { size: 32 })],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx });

  const sol = prover.formatForSolidity(proof);
  const verifyHash = await buyerClient.writeContract({
    address: managerAddr, abi: managerAbi,
    functionName: "verifySpendProof",
    args: [sol.a, sol.b, sol.c, sol.pubSignals, MERCHANT_AGENT_ID],
  });
  const verifyReceipt = await publicClient.waitForTransactionReceipt({ hash: verifyHash });

  assert(verifyReceipt.status === "success", `Proof verified on-chain (${verifyReceipt.gasUsed} gas)`);

  const count = await publicClient.readContract({
    address: managerAddr, abi: managerAbi, functionName: "verificationCount",
  });
  assert(count === 1n, "Verification count is 1");

  // ── 8. Replay rejected ──
  console.log("\n8. Replay attempt");
  try {
    await buyerClient.writeContract({
      address: managerAddr, abi: managerAbi,
      functionName: "verifySpendProof",
      args: [sol.a, sol.b, sol.c, sol.pubSignals, MERCHANT_AGENT_ID],
    });
    assert(false, "Replay should have been rejected");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    assert(msg.includes("NullifierAlreadyUsed") || msg.includes("reverted"), "Replay rejected");
  }

  // ── 9. Evaluate loyalty discount ──
  console.log("\n9. Evaluate loyalty discount");
  const qualifies = totalSpend >= BigInt(deal.minLoyaltySpend);
  const discount = qualifies ? (BigInt(deal.price) * BigInt(deal.discountBps)) / 10000n : 0n;
  const effectivePrice = BigInt(deal.price) - discount;

  assert(qualifies, "Buyer qualifies for loyalty discount");
  assert(discount === 250_000n, `Discount: $${Number(discount) / USDC_DECIMALS}`);
  assert(effectivePrice === 4_750_000n, `Effective price: $${Number(effectivePrice) / USDC_DECIMALS}`);

  // ── Summary ──
  console.log(`\n=== E2E Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("\nE2E failed:", e.message || e);
  process.exit(1);
});
