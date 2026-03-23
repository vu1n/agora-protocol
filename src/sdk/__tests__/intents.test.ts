import { describe, test, expect } from "bun:test";
import {
  createThrowawayIdentity,
  buildIntentRegistration,
  buildIntentPayload,
  matchesIntent,
  type StealthIntent,
} from "../intents.js";
import type { Address } from "viem";

describe("createThrowawayIdentity", () => {
  test("generates a valid throwaway identity with all required fields", () => {
    const identity = createThrowawayIdentity();

    // Stealth address is a valid Ethereum address
    expect(identity.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Ephemeral pubkey is uncompressed secp256k1
    expect(identity.ephemeralPubKey).toMatch(/^0x04[0-9a-f]{128}$/);
    // Private keys are 32 bytes
    expect(identity.spendingPrivKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(identity.viewingPrivKey).toMatch(/^0x[0-9a-f]{64}$/);
    // Meta has valid public keys
    expect(identity.meta.spendingPubKey).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(identity.meta.viewingPubKey).toMatch(/^0x04[0-9a-f]{128}$/);
  });

  test("generates distinct identities on each call", () => {
    const a = createThrowawayIdentity();
    const b = createThrowawayIdentity();
    expect(a.address).not.toBe(b.address);
    expect(a.spendingPrivKey).not.toBe(b.spendingPrivKey);
  });
});

describe("buildIntentRegistration", () => {
  test("produces valid 8004 registration with agora-intent service", () => {
    const intent: StealthIntent = {
      category: "coffee",
      maxPrice: 10000000n,
      loyaltyProofAvailable: true,
      respondTo: "0x1234567890123456789012345678901234567890" as Address,
    };

    const reg = buildIntentRegistration(intent, "https://example.com/intent.json");

    expect(reg.metadata.type).toBe("agent");
    expect(reg.metadata.name).toBe("anonymous-buyer");
    expect(reg.metadata.description).toContain("coffee");
    expect(reg.services).toHaveLength(1);
    expect(reg.services[0].type).toBe("agora-intent");
    expect(reg.services[0].endpoint).toBe("https://example.com/intent.json");
  });
});

describe("buildIntentPayload", () => {
  test("serializes intent to raw format", () => {
    const intent: StealthIntent = {
      category: "compute",
      maxPrice: 50000000n,
      loyaltyProofAvailable: false,
      respondTo: "0xaabbccdd00112233445566778899aabbccddeeff" as Address,
      tags: ["gpu", "ml"],
      expiresAt: 1700000000,
    };

    const payload = buildIntentPayload(intent);

    expect(payload.category).toBe("compute");
    expect(payload.maxPrice).toBe(50000000);
    expect(payload.loyaltyProofAvailable).toBe(false);
    expect(payload.respondTo).toBe("0xaabbccdd00112233445566778899aabbccddeeff");
    expect(payload.tags).toEqual(["gpu", "ml"]);
    expect(payload.expiresAt).toBe(1700000000);
  });
});

describe("matchesIntent", () => {
  const intent: StealthIntent = {
    category: "coffee",
    maxPrice: 10000000n,
    loyaltyProofAvailable: true,
    respondTo: "0x1234567890123456789012345678901234567890" as Address,
  };

  test("matches when category and price fit", () => {
    expect(matchesIntent(intent, 5000000n, "coffee")).toBe(true);
  });

  test("matches when price equals max", () => {
    expect(matchesIntent(intent, 10000000n, "coffee")).toBe(true);
  });

  test("rejects wrong category", () => {
    expect(matchesIntent(intent, 5000000n, "electronics")).toBe(false);
  });

  test("rejects price exceeding max", () => {
    expect(matchesIntent(intent, 15000000n, "coffee")).toBe(false);
  });

  test("matches any price when maxPrice is 0 (no limit)", () => {
    const noLimit: StealthIntent = { ...intent, maxPrice: 0n };
    expect(matchesIntent(noLimit, 999999999n, "coffee")).toBe(true);
  });
});
