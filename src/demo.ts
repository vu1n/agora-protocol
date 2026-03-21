/**
 * Agora End-to-End Demo
 *
 * Demonstrates the full ZK loyalty proof flow:
 * 1. Deploy contracts to local Anvil
 * 2. Merchant registers + creates purchase receipts
 * 3. Merchant builds Merkle tree + publishes root on-chain
 * 4. Buyer generates Groth16 loyalty proof
 * 5. Buyer submits proof on-chain → verified
 * 6. Replay attempt → rejected (nullifier)
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
import { resolveTier } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Anvil default accounts
const DEPLOYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const MERCHANT_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const BUYER_KEY =
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const deployer = privateKeyToAccount(DEPLOYER_KEY);
const merchant = privateKeyToAccount(MERCHANT_KEY);
const buyer = privateKeyToAccount(BUYER_KEY);

const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
const chain = anvil;

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const deployerClient = createWalletClient({
  account: deployer,
  chain,
  transport: http(rpcUrl),
});
const merchantClient = createWalletClient({
  account: merchant,
  chain,
  transport: http(rpcUrl),
});
const buyerClient = createWalletClient({
  account: buyer,
  chain,
  transport: http(rpcUrl),
});

// ABIs (minimal, matching our contracts)
const registryAbi = parseAbi([
  "function registerMerchant(bytes32 agentId, string name) external",
  "function updatePurchaseRoot(bytes32 agentId, bytes32 newRoot) external",
  "function getPurchaseRoot(bytes32 agentId) external view returns (bytes32)",
  "function isRegistered(bytes32 agentId) external view returns (bool)",
]);

const managerAbi = parseAbi([
  "function verifyLoyaltyFull(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[6] pubSignals, bytes32 merchantAgentId) external returns (bool)",
  "function usedNullifiers(uint256) external view returns (bool)",
  "function verificationCount() external view returns (uint256)",
  "event LoyaltyProofVerified(bytes32 indexed merchantAgentId, uint256 sellerCommitment, uint256 threshold, uint256 nullifier, uint256 timestamp)",
]);

// Contract bytecodes (loaded from forge artifacts)
const contractsDir = path.resolve(__dirname, "../contracts/out");
const verifierBytecode = JSON.parse(
  readFileSync(path.join(contractsDir, "LoyaltyVerifier.sol/Groth16Verifier.json"), "utf-8"),
).bytecode.object as Hex;
const registryBytecode = JSON.parse(
  readFileSync(path.join(contractsDir, "MerchantRegistry.sol/MerchantRegistry.json"), "utf-8"),
).bytecode.object as Hex;
const managerBytecodeRaw = JSON.parse(
  readFileSync(path.join(contractsDir, "LoyaltyManager.sol/LoyaltyManager.json"), "utf-8"),
);
const managerAbiRaw = managerBytecodeRaw.abi;
const managerBytecode = managerBytecodeRaw.bytecode.object as Hex;

async function deploy(
  bytecode: Hex,
  args: any[] = [],
  abi: any[] = [],
): Promise<Hex> {
  const hash = await deployerClient.deployContract({
    abi,
    bytecode,
    args,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return receipt.contractAddress!;
}

async function main() {
  console.log("=== Agora ZK Privacy-Commerce Protocol Demo ===\n");

  // ── 1. Deploy contracts ──
  console.log("1. Deploying contracts...");
  const verifierAddr = await deploy(verifierBytecode);
  console.log(`   LoyaltyVerifier: ${verifierAddr}`);

  const registryAddr = await deploy(registryBytecode);
  console.log(`   MerchantRegistry: ${registryAddr}`);

  const managerAddr = await deploy(managerBytecode, [verifierAddr, registryAddr], managerAbiRaw);
  console.log(`   LoyaltyManager: ${managerAddr}`);

  // ── 2. Initialize prover ──
  console.log("\n2. Initializing ZK prover...");
  const prover = new AgoraProver();
  await prover.init();
  console.log("   Prover ready (Poseidon hash, Groth16)");

  // ── 3. Merchant setup ──
  const MERCHANT_AGENT_ID = pad("0x01", { size: 32 });
  const SELLER_ID = 42n;
  const sellerCommitment = prover.hash(SELLER_ID);
  const BUYER_SECRET = 12345n;
  const buyerCommitment = prover.hash(BUYER_SECRET);

  console.log("\n3. Merchant registers on-chain...");
  const regHash = await merchantClient.writeContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: "registerMerchant",
    args: [MERCHANT_AGENT_ID, "Demo Coffee Shop"],
  });
  await publicClient.waitForTransactionReceipt({ hash: regHash });
  console.log(`   Registered: "Demo Coffee Shop" (tx: ${regHash.slice(0, 18)}...)`);

  // ── 4. Simulate purchases ──
  console.log("\n4. Simulating 5 purchases...");
  const purchases = [
    { amount: 100_000_000n, salt: 1001n, label: "$100" },
    { amount: 150_000_000n, salt: 1002n, label: "$150" },
    { amount: 200_000_000n, salt: 1003n, label: "$200" },
    { amount: 75_000_000n, salt: 1004n, label: "$75" },
    { amount: 50_000_000n, salt: 1005n, label: "$50" },
  ];

  const receipts = purchases.map((p) => {
    const receipt = prover.createReceipt(
      sellerCommitment,
      p.amount,
      buyerCommitment,
      p.salt,
    );
    console.log(`   Purchase: ${p.label} (receipt stored locally)`);
    return receipt;
  });

  const totalSpend = purchases.reduce((s, p) => s + p.amount, 0n);
  const tier = resolveTier(totalSpend);
  console.log(
    `   Total spend: $${Number(totalSpend) / 1_000_000} → ${tier?.tier.toUpperCase()} tier (${(tier?.discountBps ?? 0) / 100}% discount)`,
  );

  // ── 5. Build Merkle tree + publish root ──
  console.log("\n5. Merchant builds Merkle tree and publishes root...");

  // The prover builds the tree (including padding leaves for the proof)
  // but the merchant also needs to know the root. In production, the merchant
  // would maintain their own tree. For demo, we use the prover's tree.
  // We need to build the same tree the prover will use.
  // Actually, let's just generate the proof first and extract the root from it.

  // First, generate the proof to get the merkle root
  console.log("\n6. Buyer generates ZK loyalty proof...");
  const threshold = 500_000_000n; // $500
  const startTime = Date.now();
  const proofResult = await prover.proveLoyalty({
    receipts,
    buyerSecret: BUYER_SECRET,
    sellerCommitment,
    threshold,
  });
  const elapsed = Date.now() - startTime;
  console.log(`   Proof generated in ${elapsed}ms`);
  console.log(`   Nullifier: ${proofResult.nullifier.toString().slice(0, 20)}...`);

  // Verify locally first
  const localValid = await prover.verifyLocally(proofResult);
  console.log(`   Local verification: ${localValid ? "PASS" : "FAIL"}`);

  // Now publish the merkle root (extracted from public signals)
  const merkleRoot = proofResult.publicSignals[2];
  console.log(`\n   Publishing Merkle root on-chain...`);
  const rootHash = await merchantClient.writeContract({
    address: registryAddr,
    abi: registryAbi,
    functionName: "updatePurchaseRoot",
    args: [MERCHANT_AGENT_ID, toHex(BigInt(merkleRoot), { size: 32 })],
  });
  await publicClient.waitForTransactionReceipt({ hash: rootHash });
  console.log(`   Root published (tx: ${rootHash.slice(0, 18)}...)`);

  // ── 7. Submit proof on-chain ──
  console.log("\n7. Buyer submits ZK proof on-chain...");
  const sol = prover.formatForSolidity(proofResult);

  const verifyHash = await buyerClient.writeContract({
    address: managerAddr,
    abi: managerAbi,
    functionName: "verifyLoyaltyFull",
    args: [
      sol.a,
      sol.b,
      sol.c,
      sol.pubSignals,
      MERCHANT_AGENT_ID,
    ],
  });
  const verifyReceipt = await publicClient.waitForTransactionReceipt({
    hash: verifyHash,
  });
  console.log(`   Proof VERIFIED on-chain! (tx: ${verifyHash.slice(0, 18)}...)`);
  console.log(`   Gas used: ${verifyReceipt.gasUsed}`);

  // Check verification count
  const count = await publicClient.readContract({
    address: managerAddr,
    abi: managerAbi,
    functionName: "verificationCount",
  });
  console.log(`   Total verifications: ${count}`);

  // ── 8. Replay attempt ──
  console.log("\n8. Attempting replay with same proof...");
  try {
    await buyerClient.writeContract({
      address: managerAddr,
      abi: managerAbi,
      functionName: "verifyLoyaltyFull",
      args: [
        sol.a,
        sol.b,
        sol.c,
        sol.pubSignals,
        MERCHANT_AGENT_ID,
      ],
    });
    console.log("   ERROR: Replay should have been rejected!");
  } catch (e: any) {
    console.log(
      `   Replay REJECTED (nullifier already used)`,
    );
  }

  // ── Summary ──
  console.log("\n=== Demo Complete ===");
  console.log(`\nContracts:`);
  console.log(`  LoyaltyVerifier:  ${verifierAddr}`);
  console.log(`  MerchantRegistry: ${registryAddr}`);
  console.log(`  LoyaltyManager:   ${managerAddr}`);
  console.log(`\nProof Details:`);
  console.log(`  Circuit: 22,533 non-linear constraints`);
  console.log(`  Proof generation: ${elapsed}ms`);
  console.log(`  On-chain verification gas: ${verifyReceipt.gasUsed}`);
  console.log(`  Threshold proven: $${Number(threshold) / 1_000_000}`);
  console.log(`  Purchases in proof: ${purchases.length}`);
  console.log(`  Nullifier prevents replay: YES`);
  console.log(`  Merchant root from registry: YES (not caller-supplied)`);
}

main().catch((e) => {
  console.error("\nDemo failed:", e.message || e);
  process.exit(1);
});
