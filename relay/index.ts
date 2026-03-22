/**
 * Agora Privacy Relay
 *
 * A TEE-hosted service that generates Railgun ZK proofs on behalf of buyer agents.
 * The agent sends an encrypted payment request, the relay executes it privately.
 *
 * Non-custodial: the relay generates a proof that authorizes a specific payment
 * to a specific stealth address. It cannot redirect funds or steal keys — the
 * proof is bound to the exact parameters the agent requested.
 *
 * Runs in AWS Nitro enclave. Agents verify the enclave attestation before
 * sending their Railgun spending key.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { payRoute } from "./routes/pay.js";
import { attestationRoute } from "./routes/attestation.js";
import { healthRoute } from "./routes/health.js";
import { shieldRoute } from "./routes/shield.js";

const app = new Hono();

app.use("*", cors());

app.route("/health", healthRoute);
app.route("/attestation", attestationRoute);
app.route("/pay", payRoute);
app.route("/shield", shieldRoute);

export default {
  port: parseInt(process.env.PORT ?? "3100"),
  fetch: app.fetch,
};
