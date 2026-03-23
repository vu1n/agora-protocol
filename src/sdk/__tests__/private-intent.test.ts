import { describe, test, expect, mock } from "bun:test";
import { NetworkName } from "@railgun-community/shared-models";
import { createPrivateIntent } from "../private-intent.js";
import type { RailgunInstance } from "../railgun-helper.js";
import type { Address } from "viem";

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;

// Minimal mock RailgunInstance
function mockRailgunInstance(): RailgunInstance {
  return {
    walletID: "mock-wallet-id",
    walletInfo: { id: "mock-wallet-id", railgunAddress: "0zk..." } as any,
    encryptionKey: "mock-key",
    networkName: NetworkName.Arbitrum,
    getBalance: mock(() => Promise.resolve(50000000n)),
    buildConfig: (amounts, gas, opts) => ({
      walletID: "mock-wallet-id",
      encryptionKey: "mock-key",
      networkName: NetworkName.Arbitrum,
      unshieldERC20Amounts: amounts,
      gasDetails: gas,
      sendWithPublicWallet: opts?.sendWithPublicWallet ?? false,
    }),
    shutdown: mock(() => Promise.resolve()),
  };
}

describe("createPrivateIntent", () => {
  const railgun = mockRailgunInstance();
  const gasDetails = {
    maxFeePerGas: 100000000n,
    maxPriorityFeePerGas: 1n,
    gasLimit: 500000n,
  } as any;

  test("produces a complete private intent with throwaway identity", () => {
    const result = createPrivateIntent(
      railgun,
      {
        category: "coffee",
        maxPrice: 10_000_000n,
        fundingToken: USDC,
        fundingAmount: 15_000_000n,
        intentEndpoint: "https://ephemeral.example/intent.json",
        tags: ["latte"],
        loyaltyProofAvailable: true,
      },
      gasDetails,
    );

    // Throwaway identity
    expect(result.identity.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.identity.spendingPrivKey).toMatch(/^0x[0-9a-f]{64}$/);

    // Intent points to the throwaway address
    expect(result.intent.respondTo).toBe(result.identity.address);
    expect(result.intent.category).toBe("coffee");
    expect(result.intent.maxPrice).toBe(10_000_000n);
    expect(result.intent.loyaltyProofAvailable).toBe(true);
    expect(result.intent.tags).toEqual(["latte"]);

    // Registration is a valid 8004 payload
    expect(result.registration.services[0].type).toBe("agora-intent");
    expect(result.registration.services[0].endpoint).toBe(
      "https://ephemeral.example/intent.json",
    );

    // Payload is JSON-serializable
    const json = JSON.stringify(result.payload);
    expect(json).toContain("coffee");
    expect(json).toContain("10000000");

    // Funding config routes through Railgun
    expect(result.fundingConfig.walletID).toBe("mock-wallet-id");
    expect(result.fundingConfig.unshieldERC20Amounts[0].tokenAddress).toBe(USDC);
    expect(result.fundingConfig.unshieldERC20Amounts[0].amount).toBe(15_000_000n);
    expect(result.fundingConfig.sendWithPublicWallet).toBe(false);
  });

  test("each call produces a unique throwaway identity", () => {
    const a = createPrivateIntent(railgun, {
      category: "coffee",
      maxPrice: 0n,
      fundingToken: USDC,
      fundingAmount: 5_000_000n,
      intentEndpoint: "https://a.example/intent.json",
    }, gasDetails);

    const b = createPrivateIntent(railgun, {
      category: "coffee",
      maxPrice: 0n,
      fundingToken: USDC,
      fundingAmount: 5_000_000n,
      intentEndpoint: "https://b.example/intent.json",
    }, gasDetails);

    expect(a.identity.address).not.toBe(b.identity.address);
    expect(a.identity.spendingPrivKey).not.toBe(b.identity.spendingPrivKey);
    // Both intents point to their own throwaway
    expect(a.intent.respondTo).toBe(a.identity.address);
    expect(b.intent.respondTo).toBe(b.identity.address);
  });

  test("defaults loyaltyProofAvailable to false", () => {
    const result = createPrivateIntent(railgun, {
      category: "compute",
      maxPrice: 50_000_000n,
      fundingToken: USDC,
      fundingAmount: 60_000_000n,
      intentEndpoint: "https://c.example/intent.json",
    }, gasDetails);

    expect(result.intent.loyaltyProofAvailable).toBe(false);
  });
});
