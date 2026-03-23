/**
 * Reference merchant receipt server.
 *
 * Serves encrypted receipts at GET /receipts/:ephPubKey.
 * Merchants run this alongside their agent to fulfill the agora-receipts
 * service type in their ERC-8004 agent card.
 *
 * Usage:
 *   MERCHANT_VIEWING_PRIV_KEY=0x... npx tsx src/receipt-server.ts
 *
 * Or import and embed in your own server:
 *   import { createReceiptApp } from "./receipt-server.js";
 *   const app = createReceiptApp(store, viewingPrivKey);
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { encryptReceipt } from "./sdk/stealth.js";
import type { Hex } from "viem";

// ── Receipt store interface ──

export interface ReceiptRecord {
  /** JSON-serialized receipt (scopeCommitment, amount, buyerCommitment, salt, timestamp, sig) */
  receiptJson: string;
  /** Merchant's viewing private key was used to encrypt — we don't store it per-record */
}

export interface ReceiptStore {
  /** Store a receipt keyed by the buyer's ephemeral public key */
  put(ephPubKey: string, record: ReceiptRecord): Promise<void>;
  /** Retrieve a receipt by ephemeral public key */
  get(ephPubKey: string): Promise<ReceiptRecord | null>;
  /** List all stored ephemeral public keys (for debugging) */
  keys(): Promise<string[]>;
}

// ── In-memory store (reference implementation) ──

export class InMemoryReceiptStore implements ReceiptStore {
  private store = new Map<string, ReceiptRecord>();

  async put(ephPubKey: string, record: ReceiptRecord): Promise<void> {
    this.store.set(ephPubKey.toLowerCase(), record);
  }

  async get(ephPubKey: string): Promise<ReceiptRecord | null> {
    return this.store.get(ephPubKey.toLowerCase()) ?? null;
  }

  async keys(): Promise<string[]> {
    return [...this.store.keys()];
  }
}

// ── Hono app factory ──

export function createReceiptApp(store: ReceiptStore, merchantViewingPrivKey: Hex): Hono {
  const app = new Hono();
  app.use("/*", cors());

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", service: "agora-receipts" }));

  // Store a receipt (merchant calls this after detecting a stealth payment)
  app.post("/receipts/:ephPubKey", async (c) => {
    const ephPubKey = c.req.param("ephPubKey");
    if (!ephPubKey.startsWith("0x")) {
      return c.json({ error: "ephPubKey must be hex with 0x prefix" }, 400);
    }

    const body = await c.req.json<{ receipt: string }>();
    if (!body.receipt) {
      return c.json({ error: "missing receipt field" }, 400);
    }

    await store.put(ephPubKey, { receiptJson: body.receipt });
    return c.json({ stored: true }, 201);
  });

  // Serve an encrypted receipt (buyer calls this to pull their receipt)
  app.get("/receipts/:ephPubKey", async (c) => {
    const ephPubKey = c.req.param("ephPubKey");

    const record = await store.get(ephPubKey);
    if (!record) {
      return c.json({ error: "no receipt found for this ephemeral key" }, 404);
    }

    // Encrypt the receipt for this specific buyer
    const { encrypted, nonce } = encryptReceipt(
      record.receiptJson,
      merchantViewingPrivKey,
      ephPubKey as Hex,
    );

    return c.json({ encrypted, nonce });
  });

  // List stored keys (debug endpoint — disable in production)
  app.get("/receipts", async (c) => {
    const keys = await store.keys();
    return c.json({ count: keys.length, keys });
  });

  return app;
}

// ── Standalone server ──

if (import.meta.main) {
  const privKey = process.env.MERCHANT_VIEWING_PRIV_KEY;
  if (!privKey) {
    console.error("Set MERCHANT_VIEWING_PRIV_KEY env var");
    process.exit(1);
  }

  const port = parseInt(process.env.PORT ?? "3001", 10);
  const store = new InMemoryReceiptStore();
  const app = createReceiptApp(store, privKey as Hex);

  console.log(`Agora receipt server listening on :${port}`);
  console.log(`  POST /receipts/:ephPubKey  — store a receipt`);
  console.log(`  GET  /receipts/:ephPubKey  — fetch encrypted receipt`);
  console.log(`  GET  /health              — health check`);

  Bun.serve({ fetch: app.fetch, port });
}
