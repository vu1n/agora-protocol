import { describe, test, expect } from "bun:test";
import { createReceiptApp, InMemoryReceiptStore } from "../../receipt-server.js";
import { generateStealthKeys, decryptReceipt } from "../stealth.js";
import type { Hex } from "viem";

describe("receipt-server", () => {
  const merchant = generateStealthKeys();
  const store = new InMemoryReceiptStore();
  const app = createReceiptApp(store, merchant.viewingPrivKey);

  const sampleReceipt = JSON.stringify({
    scopeCommitment: "0xabc",
    amount: 5000000,
    buyerCommitment: "0xdef",
    salt: "0x123",
    timestamp: 1700000000,
  });

  // Simulate a buyer's ephemeral key (from a stealth payment)
  const buyer = generateStealthKeys();
  const ephPubKey = buyer.meta.viewingPubKey;

  test("health check returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("agora-receipts");
  });

  test("GET /receipts/:ephPubKey returns 404 when no receipt stored", async () => {
    const res = await app.request(`/receipts/${ephPubKey}`);
    expect(res.status).toBe(404);
  });

  test("POST /receipts/:ephPubKey stores a receipt", async () => {
    const res = await app.request(`/receipts/${ephPubKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receipt: sampleReceipt }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.stored).toBe(true);
  });

  test("GET /receipts/:ephPubKey returns encrypted receipt", async () => {
    const res = await app.request(`/receipts/${ephPubKey}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.encrypted).toMatch(/^0x/);
    expect(body.nonce).toMatch(/^0x/);
  });

  test("buyer can decrypt the receipt with their ephemeral private key", async () => {
    const res = await app.request(`/receipts/${ephPubKey}`);
    const { encrypted, nonce } = await res.json();

    const decrypted = decryptReceipt(
      encrypted as Hex,
      nonce as Hex,
      buyer.viewingPrivKey,
      merchant.meta.viewingPubKey,
    );

    expect(decrypted).toBe(sampleReceipt);
  });

  test("wrong key cannot decrypt the receipt", async () => {
    const res = await app.request(`/receipts/${ephPubKey}`);
    const { encrypted, nonce } = await res.json();

    const wrongBuyer = generateStealthKeys();
    expect(() =>
      decryptReceipt(
        encrypted as Hex,
        nonce as Hex,
        wrongBuyer.viewingPrivKey,
        merchant.meta.viewingPubKey,
      ),
    ).toThrow();
  });

  test("GET /receipts lists stored keys", async () => {
    const res = await app.request("/receipts");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.keys).toContain(ephPubKey.toLowerCase());
  });

  test("POST rejects missing receipt field", async () => {
    const res = await app.request(`/receipts/${ephPubKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
