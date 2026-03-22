/**
 * Attestation endpoint: proves the relay runs in a TEE.
 *
 * In Phala Cloud (Intel TDX):
 *   - Calls dstack agent to get a TDX attestation quote
 *   - Quote is bound to the Docker image hash — proves exact code running
 *   - Agents verify the quote via Intel DCAP (no trust in Phala required)
 *
 * In development:
 *   - Returns mock attestation with capabilities list
 */
import { Hono } from "hono";
import { CHAIN, CONTRACTS, RELAY_VERSION } from "../constants.js";

export const attestationRoute = new Hono();

attestationRoute.get("/", async (c) => {
  const capabilities = [
    "railgun-shield",
    "railgun-unshield-to-stealth",
    "stealth-payment",
    "loyalty-proof-submission",
  ];

  const contractInfo = {
    relayAdapt: CONTRACTS.relayAdapt,
    railgunProxy: CONTRACTS.railgunProxy,
    loyaltyManager: CONTRACTS.loyaltyManager,
    chain: CHAIN.name,
    chainId: CHAIN.id,
  };

  // Try TDX attestation (available in Phala Cloud CVM)
  try {
    const { TappdClient } = await import("@phala/dstack-sdk");
    const client = new TappdClient();
    const quote = await client.tdxQuote("agora-relay-v" + RELAY_VERSION);

    return c.json({
      mode: "tee",
      teeType: "Intel TDX (Phala Cloud)",
      relayVersion: RELAY_VERSION,
      attestation: {
        quote: quote.quote,
        replayRtmrs: quote.replayRtmrs,
      },
      verification: "Verify this quote using Intel DCAP or Phala's verification API",
      capabilities,
      contracts: contractInfo,
    });
  } catch {
    // Not in a CVM — development mode
    return c.json({
      mode: "development",
      warning: "Not running in TEE. Do not send real keys.",
      relayVersion: RELAY_VERSION,
      codeHash: process.env.GIT_COMMIT ?? "dev",
      capabilities,
      contracts: contractInfo,
    });
  }
});
