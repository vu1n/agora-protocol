/**
 * Private payment endpoint: the core of the relay.
 *
 * The agent sends a payment request. The relay:
 *   1. Validates inputs
 *   2. Plans the payment via the Agora SDK (stealth address + calldata)
 *   3. In production: generates Railgun ZK proof, submits via Relay Adapt
 *   4. Returns stealth address announcement for merchant scanning
 *
 * POST /pay
 * {
 *   "token": "0xUSDC...",
 *   "amount": "5000000",
 *   "merchantStealthMeta": {
 *     "spendingPubKey": "0x04...",
 *     "viewingPubKey": "0x04..."
 *   },
 *   "loyaltyProof": { ... },         // Optional
 *   "scopeId": "0x...",              // Optional
 *   "fee": "50000"                   // Relay fee in token units
 * }
 */
import { Hono } from "hono";
import type { Address, Hex } from "viem";
import { planStealthPayment } from "../../src/sdk/steps/payment.js";
import { CHAIN, CONTRACTS } from "../constants.js";

export const payRoute = new Hono();

payRoute.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { token, amount, merchantStealthMeta, loyaltyProof, scopeId, fee } = body;

    // Validate required fields
    if (!token || !amount || !merchantStealthMeta) {
      return c.json({ error: "Missing required fields: token, amount, merchantStealthMeta" }, 400);
    }
    if (!merchantStealthMeta.spendingPubKey || !merchantStealthMeta.viewingPubKey) {
      return c.json({ error: "merchantStealthMeta must include spendingPubKey and viewingPubKey" }, 400);
    }

    // Validate amount before doing any expensive work
    let parsedAmount: bigint;
    try {
      parsedAmount = BigInt(amount);
      if (parsedAmount <= 0n) throw new Error();
    } catch {
      return c.json({ error: "amount must be a positive numeric string" }, 400);
    }

    // Use the SDK to plan the stealth payment (derivation + calldata)
    const payment = planStealthPayment({
      token: token as Address,
      amount: parsedAmount,
      merchantMeta: {
        spendingPubKey: merchantStealthMeta.spendingPubKey as Hex,
        viewingPubKey: merchantStealthMeta.viewingPubKey as Hex,
      },
    });

    // In production (with Railgun engine in TEE):
    // The crossContractCalls from payment.stepOutput.calls would be passed to
    // populateProvedCrossContractCalls, which wraps them in unshield → calls → reshield.
    // The relay generates the Railgun ZK proof and submits via Relay Adapt.

    return c.json({
      status: "planned",
      stealthAddress: payment.stealth.stealthAddress,
      ephemeralPubKey: payment.stealth.ephemeralPubKey,
      viewTag: payment.stealth.viewTag,
      crossContractCalls: payment.stepOutput.calls,
      relayAdaptContract: CONTRACTS.relayAdapt,
      railgunProxy: CONTRACTS.railgunProxy,
      chain: CHAIN.name,
      chainId: CHAIN.id,
      token,
      amount,
      fee: fee ?? "0",
      loyaltyProofIncluded: !!loyaltyProof,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
});
