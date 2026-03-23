/**
 * Stealth Intents: anonymous buyer discovery via throwaway ERC-8004 identities.
 *
 * A buyer who wants to find merchants without revealing their identity:
 *   1. Generates a throwaway stealth keypair
 *   2. Derives a stealth address and funds it (one-transaction budget)
 *   3. Publishes an intent ("looking to buy coffee") via an ephemeral 8004 identity
 *   4. Merchants scan for intents, match, and send deal offers
 *   5. Buyer transacts from the throwaway identity, then abandons it
 *
 * The merchant never learns the buyer's real identity at any step.
 */
import type { Address, Hex } from "viem";
import { generateStealthKeys, deriveStealthAddress } from "./stealth.js";
import type { StealthMetaAddress } from "./types.js";
import type { AgentRegistration, AgentService } from "./bazaar.js";

// ── Types ──

/** A buyer's anonymous purchase intent. */
export interface StealthIntent {
  /** What the buyer is looking for (e.g., "coffee", "compute", "nft") */
  category: string;
  /** Maximum price in token smallest unit (0 = no limit) */
  maxPrice: bigint;
  /** Whether the buyer can provide a ZK loyalty proof */
  loyaltyProofAvailable: boolean;
  /** Stealth address where merchants should send deal offers */
  respondTo: Address;
  /** Optional: additional search parameters */
  tags?: string[];
  /** When this intent expires (unix timestamp, 0 = no expiry) */
  expiresAt?: number;
}

/** A throwaway identity for posting intents anonymously. */
export interface ThrowawayIdentity {
  /** The stealth address to fund and transact from */
  address: Address;
  /** Ephemeral public key (included in 8004 registration for merchant responses) */
  ephemeralPubKey: Hex;
  /** Private keys — keep these secret, discard after use */
  spendingPrivKey: Hex;
  viewingPrivKey: Hex;
  /** The stealth meta-address (public, included in the intent registration) */
  meta: StealthMetaAddress;
}

/** Raw intent format from a buyer's intent endpoint. */
interface RawIntent {
  category: string;
  maxPrice: number;
  loyaltyProofAvailable?: boolean;
  respondTo: string;
  tags?: string[];
  expiresAt?: number;
}

// ── Intent creation (buyer side) ──

/**
 * Create a throwaway identity for posting anonymous intents.
 *
 * The returned identity includes a stealth address that should be funded
 * with a single-transaction budget. After transacting, discard the keys.
 */
export function createThrowawayIdentity(): ThrowawayIdentity {
  const keys = generateStealthKeys();
  const derived = deriveStealthAddress(keys.meta);

  return {
    address: derived.stealthAddress,
    ephemeralPubKey: derived.ephemeralPubKey,
    spendingPrivKey: keys.spendingPrivKey,
    viewingPrivKey: keys.viewingPrivKey,
    meta: keys.meta,
  };
}

/**
 * Build an ERC-8004 registration payload for the throwaway identity.
 * The buyer hosts this JSON and registers it as their agentURI.
 */
export function buildIntentRegistration(
  intent: StealthIntent,
  intentEndpoint: string,
): AgentRegistration {
  return {
    metadata: {
      type: "agent",
      name: "anonymous-buyer",
      description: `Looking for ${intent.category} deals via Agora`,
    },
    services: [
      {
        type: "agora-intent",
        endpoint: intentEndpoint,
      },
    ],
  };
}

/**
 * Build the intent payload to host at the intent endpoint.
 */
export function buildIntentPayload(intent: StealthIntent): RawIntent {
  return {
    category: intent.category,
    maxPrice: Number(intent.maxPrice),
    loyaltyProofAvailable: intent.loyaltyProofAvailable,
    respondTo: intent.respondTo,
    tags: intent.tags,
    expiresAt: intent.expiresAt,
  };
}

// ── Intent discovery (merchant side) ──

const AGORA_INTENT_SERVICE = "agora-intent";

/**
 * Scan agent registrations for buyer intents.
 * Merchants call this to find anonymous buyers looking for their products.
 */
export async function discoverIntents(
  agentURIs: string[],
  opts?: { category?: string; maxResults?: number },
): Promise<StealthIntent[]> {
  const results = await Promise.allSettled(
    agentURIs.map(uri => fetchIntentFromAgent(uri)),
  );

  let intents = results
    .filter((r): r is PromiseFulfilledResult<StealthIntent | null> => r.status === "fulfilled")
    .map(r => r.value)
    .filter((i): i is StealthIntent => i !== null);

  // Filter by category
  if (opts?.category) {
    intents = intents.filter(i => i.category === opts.category);
  }

  // Filter expired
  const now = Math.floor(Date.now() / 1000);
  intents = intents.filter(i => !i.expiresAt || i.expiresAt > now);

  // Limit results
  if (opts?.maxResults) {
    intents = intents.slice(0, opts.maxResults);
  }

  return intents;
}

/**
 * Check if a deal matches a buyer's intent.
 */
export function matchesIntent(
  intent: StealthIntent,
  dealPrice: bigint,
  dealCategory: string,
): boolean {
  if (intent.category !== dealCategory) return false;
  if (intent.maxPrice > 0n && dealPrice > intent.maxPrice) return false;
  return true;
}

// ── Internal helpers ──

async function fetchIntentFromAgent(agentURI: string): Promise<StealthIntent | null> {
  try {
    const resp = await fetch(agentURI);
    if (!resp.ok) return null;
    const registration: AgentRegistration = await resp.json();

    const intentService = registration.services.find(
      (s: AgentService) => s.type === AGORA_INTENT_SERVICE,
    );
    if (!intentService) return null;

    const intentResp = await fetch(intentService.endpoint);
    if (!intentResp.ok) return null;
    const raw: RawIntent = await intentResp.json();

    return {
      category: raw.category,
      maxPrice: BigInt(raw.maxPrice),
      loyaltyProofAvailable: raw.loyaltyProofAvailable ?? false,
      respondTo: raw.respondTo as Address,
      tags: raw.tags,
      expiresAt: raw.expiresAt,
    };
  } catch {
    return null;
  }
}
