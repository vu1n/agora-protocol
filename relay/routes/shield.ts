import { Hono } from "hono";
import { CHAIN, CONTRACTS } from "../constants.js";

export const shieldRoute = new Hono();

shieldRoute.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const { token, amount, railgunAddress } = body;

    if (!token || !amount || !railgunAddress) {
      return c.json({ error: "Missing required fields: token, amount, railgunAddress" }, 400);
    }

    return c.json({
      status: "shield_ready",
      instructions: {
        step1: `Approve ${CONTRACTS.railgunProxy} to spend ${amount} of ${token}`,
        step2: "Call this endpoint again with the approval tx hash",
        step3: "Relay will construct and return the shield transaction",
      },
      proxyContract: CONTRACTS.railgunProxy,
      chain: CHAIN.name,
      chainId: CHAIN.id,
      note: "Shield is a public tx — your address is visible depositing into the pool. After shielding, your balance is private.",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
});
