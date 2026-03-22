import { Hono } from "hono";
import { CHAIN } from "../constants.js";

export const healthRoute = new Hono();

healthRoute.get("/", (c) => {
  return c.json({
    status: "ok",
    service: "agora-relay",
    tee: process.env.TEE_ENABLED === "true",
    chain: CHAIN.name,
    chainId: CHAIN.id,
  });
});
