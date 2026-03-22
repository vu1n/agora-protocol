import { describe, test, expect } from "bun:test";
import {
  generateStealthKeys,
  deriveStealthAddress,
  checkStealthAddress,
} from "../stealth.js";

describe("generateStealthKeys", () => {
  test("returns non-empty keys of correct byte length", () => {
    const keys = generateStealthKeys();

    // Private keys are 32 bytes = 66 hex chars with 0x prefix
    expect(keys.spendingPrivKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keys.viewingPrivKey).toMatch(/^0x[0-9a-f]{64}$/);

    // Public keys are uncompressed secp256k1: 04 || x(32) || y(32) = 65 bytes = 132 hex chars
    expect(keys.meta.spendingPubKey).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(keys.meta.viewingPubKey).toMatch(/^0x04[0-9a-f]{128}$/);
  });

  test("generates distinct keypairs on each call", () => {
    const a = generateStealthKeys();
    const b = generateStealthKeys();
    expect(a.spendingPrivKey).not.toBe(b.spendingPrivKey);
    expect(a.viewingPrivKey).not.toBe(b.viewingPrivKey);
  });
});

describe("deriveStealthAddress", () => {
  test("produces a valid checksummed Ethereum address", () => {
    const { meta } = generateStealthKeys();
    const result = deriveStealthAddress(meta);

    // Valid Ethereum address: 0x + 40 hex chars
    expect(result.stealthAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Ephemeral pubkey: uncompressed secp256k1
    expect(result.ephemeralPubKey).toMatch(/^0x04[0-9a-f]{128}$/);
    // View tag: single byte 0-255
    expect(result.viewTag).toBeGreaterThanOrEqual(0);
    expect(result.viewTag).toBeLessThanOrEqual(255);
  });

  test("multiple derivations from same meta-address produce different stealth addresses", () => {
    const { meta } = generateStealthKeys();
    const results = Array.from({ length: 5 }, () => deriveStealthAddress(meta));

    const addresses = results.map((r) => r.stealthAddress);
    const unique = new Set(addresses);
    // Each call uses a fresh ephemeral key, so addresses must differ
    expect(unique.size).toBe(5);
  });
});

describe("checkStealthAddress", () => {
  test("detects payment with correct viewing key (positive case)", () => {
    const merchant = generateStealthKeys();
    const derived = deriveStealthAddress(merchant.meta);

    const check = checkStealthAddress(
      derived.ephemeralPubKey,
      derived.viewTag,
      merchant.viewingPrivKey,
      merchant.meta.spendingPubKey,
    );

    expect(check.match).toBe(true);
    expect(check.stealthAddress).toBe(derived.stealthAddress);
  });

  test("rejects wrong viewing key", () => {
    const merchant = generateStealthKeys();
    const derived = deriveStealthAddress(merchant.meta);

    // Use a different merchant's viewing private key
    const wrongMerchant = generateStealthKeys();

    const check = checkStealthAddress(
      derived.ephemeralPubKey,
      derived.viewTag,
      wrongMerchant.viewingPrivKey,
      merchant.meta.spendingPubKey,
    );

    // Wrong viewing key produces a different shared secret, so view tag almost
    // certainly won't match (1/256 chance of false positive).
    // If the tag happens to match by chance, the stealth address will still differ.
    if (check.match) {
      expect(check.stealthAddress).not.toBe(derived.stealthAddress);
    } else {
      expect(check.match).toBe(false);
      expect(check.stealthAddress).toBeUndefined();
    }
  });

  test("rejects wrong view tag", () => {
    const merchant = generateStealthKeys();
    const derived = deriveStealthAddress(merchant.meta);

    // Flip the view tag to a guaranteed-different value
    const wrongTag = (derived.viewTag + 1) % 256;

    const check = checkStealthAddress(
      derived.ephemeralPubKey,
      wrongTag,
      merchant.viewingPrivKey,
      merchant.meta.spendingPubKey,
    );

    expect(check.match).toBe(false);
    expect(check.stealthAddress).toBeUndefined();
  });
});
