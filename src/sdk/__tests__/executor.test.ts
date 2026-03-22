import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Address, Hex, WalletClient } from "viem";
import type { RecipePlan, AgoraSDKConfig } from "../types.js";
import type { RailgunConfig } from "../executor.js";
import {
  TXIDVersion,
  NetworkName,
  EVMGasType,
} from "@railgun-community/shared-models";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGenerateProof = mock(() => Promise.resolve());
const mockPopulate = mock(() =>
  Promise.resolve({
    transaction: {
      to: "0xRelayAdapt",
      data: "0xproofcalldata",
      value: 0n,
      gasLimit: 500_000n,
    },
    nullifiers: [],
    preTransactionPOIsPerTxidLeafPerList: {},
  }),
);

mock.module("@railgun-community/wallet", () => ({
  generateCrossContractCallsProof: mockGenerateProof,
  populateProvedCrossContractCalls: mockPopulate,
}));

// Mock viem's createPublicClient so the constructor doesn't need a real RPC.
const mockReadContract = mock();
const mockWaitForTransactionReceipt = mock();

mock.module("viem", () => {
  // Re-export everything real, but override createPublicClient.
  const actual = require("viem");
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: mockReadContract,
      waitForTransactionReceipt: mockWaitForTransactionReceipt,
    }),
  };
});

// Import executor *after* mocks are installed.
const { AgoraExecutor } = await import("../executor.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const SCOPE_ID =
  "0xaabbccdd00000000000000000000000000000000000000000000000000000000" as Hex;
const MERCHANT_ROOT =
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
const TX_HASH =
  "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as Hex;

const TEST_CONFIG: AgoraSDKConfig = {
  rpcUrl: "http://localhost:8545",
  chainId: 1,
  contracts: {
    verifier: "0x0000000000000000000000000000000000000001",
    registry: "0x0000000000000000000000000000000000000002",
    manager: "0x0000000000000000000000000000000000000003",
  },
};

function makePlan(overrides?: Partial<RecipePlan>): RecipePlan {
  return {
    steps: [
      {
        calls: [
          {
            to: USDC,
            data: "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000098968000" as Hex,
            value: 0n,
          },
        ],
        tokensSpent: [{ token: USDC, amount: 10_000_000n }],
        tokensProduced: [],
      },
    ],
    allCalls: [
      {
        to: USDC,
        data: "0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000098968000" as Hex,
        value: 0n,
      },
    ],
    totalSpent: [{ token: USDC, amount: 10_000_000n }],
    merchantRootSnapshot: { scopeId: SCOPE_ID, root: MERCHANT_ROOT },
    ...overrides,
  };
}

function makeRailgunConfig(
  overrides?: Partial<RailgunConfig>,
): RailgunConfig {
  return {
    walletID: "test-wallet-id",
    encryptionKey: "0xencryptionkey",
    networkName: NetworkName.Arbitrum,
    unshieldERC20Amounts: [
      { tokenAddress: USDC, amount: 10_000_000n },
    ],
    gasDetails: {
      evmGasType: EVMGasType.Type2,
      gasEstimate: 500_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    },
    sendWithPublicWallet: false,
    ...overrides,
  };
}

function makeMockWalletClient(): WalletClient {
  return {
    sendTransaction: mock(() => Promise.resolve(TX_HASH)),
    chain: { id: 1, name: "mainnet" },
    account: { address: "0xAgentAddress" },
  } as unknown as WalletClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgoraExecutor.executeRailgun", () => {
  let executor: InstanceType<typeof AgoraExecutor>;

  beforeEach(() => {
    mockGenerateProof.mockClear();
    mockPopulate.mockClear();
    mockReadContract.mockClear();
    mockWaitForTransactionReceipt.mockClear();

    // Default: root matches (verifyRootSnapshot passes)
    mockReadContract.mockResolvedValue(MERCHANT_ROOT);
    // Default: receipt comes back with gasUsed
    mockWaitForTransactionReceipt.mockResolvedValue({
      gasUsed: 420_000n,
    });

    executor = new AgoraExecutor(TEST_CONFIG);
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  test("calls generateCrossContractCallsProof with correct parameters", async () => {
    const plan = makePlan();
    const railgun = makeRailgunConfig();
    const wallet = makeMockWalletClient();

    await executor.executeRailgun(plan, railgun, wallet);

    expect(mockGenerateProof).toHaveBeenCalledTimes(1);

    const args = mockGenerateProof.mock.calls[0];

    // positional args per the function signature
    expect(args[0]).toBe(TXIDVersion.V2_PoseidonMerkle); // txidVersion
    expect(args[1]).toBe(NetworkName.Arbitrum);           // networkName
    expect(args[2]).toBe("test-wallet-id");               // walletID
    expect(args[3]).toBe("0xencryptionkey");              // encryptionKey
    expect(args[4]).toEqual(railgun.unshieldERC20Amounts);// unshieldERC20Amounts
    expect(args[5]).toEqual([]);                          // no NFTs
    expect(args[6]).toEqual([]);                          // reshieldERC20Recipients (default empty)
    expect(args[7]).toEqual([]);                          // no NFT reshield
    // crossContractCalls — converted from plan.allCalls
    expect(args[8]).toEqual([
      { to: plan.allCalls[0].to, data: plan.allCalls[0].data, value: 0n },
    ]);
    expect(args[9]).toBeUndefined();                      // broadcasterFee
    expect(args[10]).toBe(false);                         // sendWithPublicWallet
    expect(args[11]).toBe(0n);                            // overallBatchMinGasPrice
    expect(args[12]).toBeUndefined();                     // minGasLimit
    expect(typeof args[13]).toBe("function");             // progress callback
  });

  test("calls populateProvedCrossContractCalls after proof generation", async () => {
    const plan = makePlan();
    const railgun = makeRailgunConfig();
    const wallet = makeMockWalletClient();

    await executor.executeRailgun(plan, railgun, wallet);

    expect(mockPopulate).toHaveBeenCalledTimes(1);

    const args = mockPopulate.mock.calls[0];

    expect(args[0]).toBe(TXIDVersion.V2_PoseidonMerkle);
    expect(args[1]).toBe(NetworkName.Arbitrum);
    expect(args[2]).toBe("test-wallet-id");
    expect(args[3]).toEqual(railgun.unshieldERC20Amounts);
    expect(args[4]).toEqual([]);                          // no NFTs
    expect(args[5]).toEqual([]);                          // reshieldERC20Recipients
    expect(args[6]).toEqual([]);                          // no NFT reshield
    // crossContractCalls
    expect(args[7]).toEqual([
      { to: plan.allCalls[0].to, data: plan.allCalls[0].data, value: 0n },
    ]);
    expect(args[8]).toBeUndefined();                      // broadcasterFee
    expect(args[9]).toBe(false);                          // sendWithPublicWallet
    expect(args[10]).toBe(0n);                            // overallBatchMinGasPrice
    expect(args[11]).toEqual(railgun.gasDetails);         // gasDetails
  });

  test("proof generation is called before populate", async () => {
    const callOrder: string[] = [];

    mockGenerateProof.mockImplementation(async () => {
      callOrder.push("generateProof");
    });
    mockPopulate.mockImplementation(async () => {
      callOrder.push("populate");
      return {
        transaction: {
          to: "0xRelayAdapt",
          data: "0xproofcalldata",
          value: 0n,
          gasLimit: 500_000n,
        },
        nullifiers: [],
        preTransactionPOIsPerTxidLeafPerList: {},
      };
    });

    await executor.executeRailgun(makePlan(), makeRailgunConfig(), makeMockWalletClient());

    expect(callOrder).toEqual(["generateProof", "populate"]);
  });

  // -----------------------------------------------------------------------
  // Cross-contract call conversion
  // -----------------------------------------------------------------------

  test("converts plan.allCalls to ethers ContractTransaction format", async () => {
    const plan = makePlan({
      allCalls: [
        { to: USDC, data: "0xaabb" as Hex, value: 100n },
        {
          to: "0x2222222222222222222222222222222222222222" as Address,
          data: "0xccdd" as Hex,
          // value intentionally omitted — should default to 0n
        },
      ],
    });

    await executor.executeRailgun(plan, makeRailgunConfig(), makeMockWalletClient());

    const crossContractCalls = mockGenerateProof.mock.calls[0][8];

    expect(crossContractCalls).toHaveLength(2);
    // First call: value preserved
    expect(crossContractCalls[0]).toEqual({
      to: USDC,
      data: "0xaabb",
      value: 100n,
    });
    // Second call: undefined value → 0n
    expect(crossContractCalls[1]).toEqual({
      to: "0x2222222222222222222222222222222222222222",
      data: "0xccdd",
      value: 0n,
    });
  });

  // -----------------------------------------------------------------------
  // Root snapshot verification
  // -----------------------------------------------------------------------

  test("verifies root snapshot before executing", async () => {
    const plan = makePlan();
    const wallet = makeMockWalletClient();

    await executor.executeRailgun(plan, makeRailgunConfig(), wallet);

    // readContract should have been called to check the root
    expect(mockReadContract).toHaveBeenCalledTimes(1);
    expect(mockReadContract.mock.calls[0][0]).toMatchObject({
      address: TEST_CONFIG.contracts.registry,
      functionName: "getPurchaseRoot",
      args: [SCOPE_ID],
    });

    // Proof generation should happen after root check passes
    expect(mockGenerateProof).toHaveBeenCalledTimes(1);
  });

  test("skips root verification when merchantRootSnapshot is null", async () => {
    const plan = makePlan({ merchantRootSnapshot: null });

    await executor.executeRailgun(plan, makeRailgunConfig(), makeMockWalletClient());

    // readContract should NOT have been called
    expect(mockReadContract).not.toHaveBeenCalled();
    // But proof generation should still proceed
    expect(mockGenerateProof).toHaveBeenCalledTimes(1);
  });

  test("throws on root mismatch", async () => {
    const staleRoot =
      "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" as Hex;
    mockReadContract.mockResolvedValue(staleRoot);

    const plan = makePlan();

    await expect(
      executor.executeRailgun(plan, makeRailgunConfig(), makeMockWalletClient()),
    ).rejects.toThrow("Merchant root changed");

    // Should NOT proceed to proof generation
    expect(mockGenerateProof).not.toHaveBeenCalled();
    expect(mockPopulate).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Transaction submission
  // -----------------------------------------------------------------------

  test("submits the populated transaction via walletClient", async () => {
    const wallet = makeMockWalletClient();

    await executor.executeRailgun(makePlan(), makeRailgunConfig(), wallet);

    const sendTx = (wallet.sendTransaction as ReturnType<typeof mock>);
    expect(sendTx).toHaveBeenCalledTimes(1);

    const txArg = sendTx.mock.calls[0][0];
    expect(txArg.to).toBe("0xRelayAdapt");
    expect(txArg.data).toBe("0xproofcalldata");
  });

  test("returns ExecutionResult with correct shape", async () => {
    const result = await executor.executeRailgun(
      makePlan(),
      makeRailgunConfig(),
      makeMockWalletClient(),
    );

    expect(result.mode).toBe("railgun");
    expect(result.txHashes).toEqual([TX_HASH]);
    expect(result.totalGasUsed).toBe(420_000n);
  });

  // -----------------------------------------------------------------------
  // Optional config forwarding
  // -----------------------------------------------------------------------

  test("forwards reshieldERC20Recipients when provided", async () => {
    const reshieldRecipients = [
      { tokenAddress: USDC, recipientAddress: "0xRailgunAddress" },
    ];
    const railgun = makeRailgunConfig({
      reshieldERC20Recipients: reshieldRecipients,
    });

    await executor.executeRailgun(makePlan(), railgun, makeMockWalletClient());

    // Check generateProof arg index 6 (reshieldERC20Recipients)
    expect(mockGenerateProof.mock.calls[0][6]).toEqual(reshieldRecipients);
    // Check populate arg index 5
    expect(mockPopulate.mock.calls[0][5]).toEqual(reshieldRecipients);
  });

  test("forwards broadcasterFee when provided", async () => {
    const fee = {
      tokenAddress: USDC,
      amount: 50_000n,
      recipientAddress: "0xBroadcaster",
    };
    const railgun = makeRailgunConfig({ broadcasterFee: fee });

    await executor.executeRailgun(makePlan(), railgun, makeMockWalletClient());

    // generateProof arg index 9
    expect(mockGenerateProof.mock.calls[0][9]).toEqual(fee);
    // populate arg index 8
    expect(mockPopulate.mock.calls[0][8]).toEqual(fee);
  });

  test("forwards sendWithPublicWallet flag", async () => {
    const railgun = makeRailgunConfig({ sendWithPublicWallet: true });

    await executor.executeRailgun(makePlan(), railgun, makeMockWalletClient());

    // generateProof arg index 10
    expect(mockGenerateProof.mock.calls[0][10]).toBe(true);
    // populate arg index 9
    expect(mockPopulate.mock.calls[0][9]).toBe(true);
  });
});
