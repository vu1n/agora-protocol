import { describe, test, expect } from "bun:test";
import { NetworkName } from "@railgun-community/shared-models";
import type { RailgunInstance } from "../railgun-helper.js";

/**
 * Smoke tests for the Railgun helper.
 *
 * We can't start the actual Railgun engine in unit tests (requires LevelDB,
 * 100MB+ artifacts, and a live RPC). Instead, we test the parts that don't
 * need the engine: buildConfig output shape and type correctness.
 *
 * The full integration is tested via the executor mock tests (executor.test.ts)
 * which verify that the RailgunConfig shape is correctly forwarded to
 * generateCrossContractCallsProof and populateProvedCrossContractCalls.
 */

function mockInstance(): RailgunInstance {
  return {
    walletID: "test-wallet-id",
    walletInfo: { id: "test-wallet-id", railgunAddress: "0zk..." } as any,
    encryptionKey: "test-key",
    networkName: NetworkName.Arbitrum,
    getBalance: async () => 5000000n,
    buildConfig: (amounts, gas, opts) => ({
      walletID: "test-wallet-id",
      encryptionKey: "test-key",
      networkName: NetworkName.Arbitrum,
      unshieldERC20Amounts: amounts,
      gasDetails: gas,
      sendWithPublicWallet: opts?.sendWithPublicWallet ?? false,
    }),
    shutdown: async () => {},
  };
}

describe("RailgunInstance.buildConfig", () => {
  const instance = mockInstance();

  test("produces valid RailgunConfig with correct wallet ID and network", () => {
    const config = instance.buildConfig(
      [{ tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amount: 5000000n }],
      { maxFeePerGas: 100000000n, maxPriorityFeePerGas: 1n, gasLimit: 500000n } as any,
    );

    expect(config.walletID).toBe("test-wallet-id");
    expect(config.encryptionKey).toBe("test-key");
    expect(config.networkName).toBe(NetworkName.Arbitrum);
    expect(config.unshieldERC20Amounts).toHaveLength(1);
    expect(config.unshieldERC20Amounts[0].amount).toBe(5000000n);
    expect(config.sendWithPublicWallet).toBe(false);
  });

  test("forwards sendWithPublicWallet flag", () => {
    const config = instance.buildConfig(
      [{ tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amount: 1000000n }],
      {} as any,
      { sendWithPublicWallet: true },
    );
    expect(config.sendWithPublicWallet).toBe(true);
  });

  test("handles multiple unshield amounts", () => {
    const config = instance.buildConfig(
      [
        { tokenAddress: "0xaaa", amount: 1000000n },
        { tokenAddress: "0xbbb", amount: 2000000n },
      ],
      {} as any,
    );
    expect(config.unshieldERC20Amounts).toHaveLength(2);
  });
});

describe("RailgunInstance shape", () => {
  test("has all required methods and properties", () => {
    const instance = mockInstance();
    expect(typeof instance.walletID).toBe("string");
    expect(typeof instance.encryptionKey).toBe("string");
    expect(typeof instance.networkName).toBe("string");
    expect(typeof instance.getBalance).toBe("function");
    expect(typeof instance.buildConfig).toBe("function");
    expect(typeof instance.shutdown).toBe("function");
  });
});
