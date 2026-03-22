import { Hono } from "hono";
import { CHAIN, CONTRACTS, RELAY_VERSION } from "../constants.js";

export const attestationRoute = new Hono();

attestationRoute.get("/", async (c) => {
  if (process.env.TEE_ENABLED === "true") {
    return c.json({ error: "Nitro attestation not yet wired — requires enclave deployment" }, 501);
  }

  return c.json({
    mode: "development",
    warning: "This is NOT a real TEE attestation. Do not send real keys.",
    codeHash: process.env.GIT_COMMIT ?? "dev",
    relayVersion: RELAY_VERSION,
    capabilities: [
      "railgun-shield",
      "railgun-unshield-to-stealth",
      "stealth-payment",
      "loyalty-proof-submission",
    ],
    contracts: {
      relayAdapt: CONTRACTS.relayAdapt,
      railgunProxy: CONTRACTS.railgunProxy,
      chain: CHAIN.name,
      chainId: CHAIN.id,
    },
  });
});
