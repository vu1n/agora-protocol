import { describe, test, expect } from "bun:test";
import {
  generateStealthKeys,
  encryptReceipt,
  decryptReceipt,
} from "../stealth.js";
import type { Hex } from "viem";

describe("encryptReceipt / decryptReceipt", () => {
  const sampleReceipt = JSON.stringify({
    scopeCommitment: "0xabc123",
    amount: 5000000,
    buyerCommitment: "0xdef456",
    salt: "0x789",
    timestamp: 1700000000,
  });

  test("round-trip: encrypt then decrypt returns original receipt", () => {
    const merchant = generateStealthKeys();
    const buyer = generateStealthKeys();

    // Merchant encrypts receipt for the buyer's ephemeral pubkey
    const { encrypted, nonce } = encryptReceipt(
      sampleReceipt,
      merchant.viewingPrivKey,
      buyer.meta.viewingPubKey, // simulating buyer's ephemeral pubkey
    );

    // Buyer decrypts with their ephemeral private key + merchant's viewing pubkey
    const decrypted = decryptReceipt(
      encrypted,
      nonce,
      buyer.viewingPrivKey, // simulating buyer's ephemeral private key
      merchant.meta.viewingPubKey,
    );

    expect(decrypted).toBe(sampleReceipt);
  });

  test("produces different ciphertext on each call (random nonce)", () => {
    const merchant = generateStealthKeys();
    const buyer = generateStealthKeys();

    const a = encryptReceipt(sampleReceipt, merchant.viewingPrivKey, buyer.meta.viewingPubKey);
    const b = encryptReceipt(sampleReceipt, merchant.viewingPrivKey, buyer.meta.viewingPubKey);

    // Same plaintext, different nonce → different ciphertext
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.encrypted).not.toBe(b.encrypted);
  });

  test("wrong key throws on decrypt (Poly1305 auth tag failure)", () => {
    const merchant = generateStealthKeys();
    const buyer = generateStealthKeys();
    const wrongKey = generateStealthKeys();

    const { encrypted, nonce } = encryptReceipt(
      sampleReceipt,
      merchant.viewingPrivKey,
      buyer.meta.viewingPubKey,
    );

    // Attempting to decrypt with wrong private key should throw
    expect(() =>
      decryptReceipt(
        encrypted,
        nonce,
        wrongKey.viewingPrivKey, // wrong key
        merchant.meta.viewingPubKey,
      ),
    ).toThrow();
  });

  test("tampered ciphertext throws on decrypt", () => {
    const merchant = generateStealthKeys();
    const buyer = generateStealthKeys();

    const { encrypted, nonce } = encryptReceipt(
      sampleReceipt,
      merchant.viewingPrivKey,
      buyer.meta.viewingPubKey,
    );

    // Flip a byte in the ciphertext
    const bytes = Buffer.from(encrypted.slice(2), "hex");
    bytes[10] ^= 0xff;
    const tampered = ("0x" + bytes.toString("hex")) as Hex;

    expect(() =>
      decryptReceipt(
        tampered,
        nonce,
        buyer.viewingPrivKey,
        merchant.meta.viewingPubKey,
      ),
    ).toThrow();
  });

  test("wrong nonce throws on decrypt", () => {
    const merchant = generateStealthKeys();
    const buyer = generateStealthKeys();

    const { encrypted, nonce } = encryptReceipt(
      sampleReceipt,
      merchant.viewingPrivKey,
      buyer.meta.viewingPubKey,
    );

    // Flip a byte in the nonce
    const nonceBytes = Buffer.from(nonce.slice(2), "hex");
    nonceBytes[0] ^= 0xff;
    const wrongNonce = ("0x" + nonceBytes.toString("hex")) as Hex;

    expect(() =>
      decryptReceipt(
        encrypted,
        wrongNonce,
        buyer.viewingPrivKey,
        merchant.meta.viewingPubKey,
      ),
    ).toThrow();
  });

  test("empty plaintext round-trips correctly", () => {
    const merchant = generateStealthKeys();
    const buyer = generateStealthKeys();

    const { encrypted, nonce } = encryptReceipt(
      "",
      merchant.viewingPrivKey,
      buyer.meta.viewingPubKey,
    );

    const decrypted = decryptReceipt(
      encrypted,
      nonce,
      buyer.viewingPrivKey,
      merchant.meta.viewingPubKey,
    );

    expect(decrypted).toBe("");
  });
});
