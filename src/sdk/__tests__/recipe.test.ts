import { describe, test, expect } from "bun:test";
import { planAgoraRecipe } from "../recipe.js";
import { planStealthPayment } from "../steps/payment.js";
import { generateStealthKeys } from "../stealth.js";
import type { AgoraSDKConfig, StealthMetaAddress } from "../types.js";
import type { LoyaltyProofResult } from "../../types.js";
import type { AgoraProver } from "../../prover.js";
import type { Address, Hex } from "viem";

const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AMOUNT = 10_000_000n; // 10 USDC (6 decimals)

const TEST_CONFIG: AgoraSDKConfig = {
  rpcUrl: "http://localhost:8545",
  chainId: 1,
  contracts: {
    verifier: "0x0000000000000000000000000000000000000001",
    registry: "0x0000000000000000000000000000000000000002",
    manager: "0x0000000000000000000000000000000000000003",
  },
};

const SCOPE_ID = "0xaabbccdd00000000000000000000000000000000000000000000000000000000" as Hex;
const MERCHANT_ROOT = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;

function makeFakeLoyaltyProof(): LoyaltyProofResult {
  return {
    proof: {
      pi_a: ["1", "2"],
      pi_b: [
        ["3", "4"],
        ["5", "6"],
      ],
      pi_c: ["7", "8"],
    },
    publicSignals: ["100", "200", "300", "400", "500", "600"],
    nullifier: 999n,
  };
}

/** Minimal mock that only implements formatForSolidity (needed by planLoyaltyProof). */
function makeMockProver(): AgoraProver {
  return {
    formatForSolidity(result: LoyaltyProofResult) {
      const { proof, publicSignals } = result;
      return {
        a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as const,
        b: [
          [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
          [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
        ] as const,
        c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as const,
        pubSignals: publicSignals.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint],
      };
    },
  } as unknown as AgoraProver;
}

describe("planAgoraRecipe", () => {
  const merchantKeys = generateStealthKeys();

  test("produces 1 call for payment-only (no loyalty proof)", () => {
    const result = planAgoraRecipe(
      {
        token: USDC,
        amount: AMOUNT,
        merchantMeta: merchantKeys.meta,
        scopeId: SCOPE_ID,
        currentMerchantRoot: MERCHANT_ROOT,
      },
      TEST_CONFIG,
    );

    expect(result.plan.steps).toHaveLength(1);
    expect(result.plan.allCalls).toHaveLength(1);
    // The single call should be an ERC20 transfer
    expect(result.plan.allCalls[0].to).toBe(USDC);
  });

  test("produces 2 calls when loyaltyProof is provided", () => {
    const result = planAgoraRecipe(
      {
        token: USDC,
        amount: AMOUNT,
        merchantMeta: merchantKeys.meta,
        scopeId: SCOPE_ID,
        currentMerchantRoot: MERCHANT_ROOT,
        loyaltyProof: makeFakeLoyaltyProof(),
      },
      TEST_CONFIG,
      makeMockProver(),
    );

    expect(result.plan.steps).toHaveLength(2);
    expect(result.plan.allCalls).toHaveLength(2);
    // First call: ERC20 transfer to stealth address
    expect(result.plan.allCalls[0].to).toBe(USDC);
    // Second call: verifySpendProof on manager
    expect(result.plan.allCalls[1].to).toBe(TEST_CONFIG.contracts.manager);
  });

  test("throws when loyaltyProof provided without prover", () => {
    expect(() =>
      planAgoraRecipe(
        {
          token: USDC,
          amount: AMOUNT,
          merchantMeta: merchantKeys.meta,
          scopeId: SCOPE_ID,
          currentMerchantRoot: MERCHANT_ROOT,
          loyaltyProof: makeFakeLoyaltyProof(),
        },
        TEST_CONFIG,
        // no prover
      ),
    ).toThrow("prover is required when loyaltyProof is provided");
  });

  test("includes merchantRootSnapshot in plan", () => {
    const result = planAgoraRecipe(
      {
        token: USDC,
        amount: AMOUNT,
        merchantMeta: merchantKeys.meta,
        scopeId: SCOPE_ID,
        currentMerchantRoot: MERCHANT_ROOT,
      },
      TEST_CONFIG,
    );

    expect(result.plan.merchantRootSnapshot).toEqual({
      scopeId: SCOPE_ID,
      root: MERCHANT_ROOT,
    });
  });
});

describe("planStealthPayment", () => {
  const merchantKeys = generateStealthKeys();

  test("produces ERC20 transfer calldata", () => {
    const result = planStealthPayment({
      token: USDC,
      amount: AMOUNT,
      merchantMeta: merchantKeys.meta,
    });

    const { stepOutput, stealth } = result;

    // Single ERC20 transfer call
    expect(stepOutput.calls).toHaveLength(1);
    expect(stepOutput.calls[0].to).toBe(USDC);
    // Calldata starts with transfer(address,uint256) selector: 0xa9059cbb
    expect(stepOutput.calls[0].data.startsWith("0xa9059cbb")).toBe(true);

    // Stealth result is valid
    expect(stealth.stealthAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(stealth.ephemeralPubKey).toMatch(/^0x04[0-9a-f]{128}$/);
  });

  test("tokensSpent matches the payment amount", () => {
    const result = planStealthPayment({
      token: USDC,
      amount: AMOUNT,
      merchantMeta: merchantKeys.meta,
    });

    expect(result.stepOutput.tokensSpent).toHaveLength(1);
    expect(result.stepOutput.tokensSpent[0].token).toBe(USDC);
    expect(result.stepOutput.tokensSpent[0].amount).toBe(AMOUNT);
    // Payment leaves the recipe — nothing produced
    expect(result.stepOutput.tokensProduced).toHaveLength(0);
  });
});
