/**
 * Deal discovery via ERC-8004 agent identities.
 *
 * Merchants advertise deals through their 8004 agent registration:
 *   - agentURI → registration file with service endpoints
 *   - services[type="agora-deals"] → URL to deal catalog (JSON)
 *   - on-chain metadata → category, stealth meta-address
 *
 * Buyer agents discover merchants by querying the 8004 registry,
 * then fetch deal catalogs from each merchant's endpoint.
 * No central bazaar contract — discovery is peer-to-peer via 8004.
 */
import type { Address, Hex } from "viem";
import type { StealthMetaAddress } from "./types.js";

/** A deal published by a merchant via their 8004 service endpoint. */
export interface Deal {
  merchantAgentId: string;
  merchantName: string;
  item: string;
  category: string;
  price: bigint;
  currency: string;
  discountBps: number;
  minLoyaltySpend: bigint;
  stealthMeta: StealthMetaAddress;
  expiresAt?: number;
}

/** Minimal 8004 agent registration file structure (subset we care about). */
export interface AgentRegistration {
  metadata: {
    type: string;
    name: string;
    description?: string;
  };
  services: AgentService[];
}

export interface AgentService {
  type: string;
  endpoint: string;
  version?: string;
  skills?: string[];
}

/** Raw deal format from a merchant's deals endpoint. */
interface RawDeal {
  item: string;
  category: string;
  price: number;
  currency?: string;
  discountBps?: number;
  minLoyaltySpend?: number;
  stealthMetaAddress?: { spendingPubKey: string; viewingPubKey: string };
  expiresAt?: number;
}

const AGORA_DEALS_SERVICE = "agora-deals";

export class DealDiscovery {
  /**
   * Discover deals from a merchant's 8004 agent registration.
   * Fetches the agentURI, finds the agora-deals service, loads the catalog.
   */
  async fetchDealsFromAgent(
    agentURI: string,
    merchantAgentId: string,
  ): Promise<Deal[]> {
    // Fetch agent registration file
    const registration = await this.fetchRegistration(agentURI);
    if (!registration) return [];

    // Find agora-deals service endpoint
    const dealsService = registration.services.find(
      s => s.type === AGORA_DEALS_SERVICE,
    );
    if (!dealsService) return [];

    // Fetch deal catalog from endpoint
    const rawDeals = await this.fetchDealCatalog(dealsService.endpoint);

    return rawDeals.map(raw => ({
      merchantAgentId,
      merchantName: registration.metadata.name,
      item: raw.item,
      category: raw.category,
      price: BigInt(raw.price),
      currency: raw.currency ?? "USDC",
      discountBps: raw.discountBps ?? 0,
      minLoyaltySpend: BigInt(raw.minLoyaltySpend ?? 0),
      stealthMeta: raw.stealthMetaAddress
        ? {
            spendingPubKey: raw.stealthMetaAddress.spendingPubKey as Hex,
            viewingPubKey: raw.stealthMetaAddress.viewingPubKey as Hex,
          }
        : { spendingPubKey: "0x" as Hex, viewingPubKey: "0x" as Hex },
      expiresAt: raw.expiresAt,
    }));
  }

  /**
   * Discover deals from multiple merchants.
   * Takes a list of (agentURI, agentId) pairs — sourced from 8004 registry queries.
   */
  async discoverDeals(
    agents: { agentURI: string; agentId: string }[],
    opts?: { category?: string },
  ): Promise<Deal[]> {
    const results = await Promise.allSettled(
      agents.map(a => this.fetchDealsFromAgent(a.agentURI, a.agentId)),
    );

    let deals = results
      .filter((r): r is PromiseFulfilledResult<Deal[]> => r.status === "fulfilled")
      .flatMap(r => r.value);

    if (opts?.category) {
      deals = deals.filter(d => d.category === opts.category);
    }

    // Filter expired
    const now = Math.floor(Date.now() / 1000);
    deals = deals.filter(d => !d.expiresAt || d.expiresAt > now);

    return deals;
  }

  /**
   * Evaluate a deal against buyer's private spend history.
   * Runs locally — no data leaves the agent.
   */
  evaluateDeal(
    deal: Deal,
    buyerTotalSpend: bigint,
  ): { qualifies: boolean; effectivePrice: bigint; savings: bigint } {
    const qualifies = buyerTotalSpend >= deal.minLoyaltySpend && deal.discountBps > 0;
    const savings = qualifies
      ? (deal.price * BigInt(deal.discountBps)) / 10000n
      : 0n;

    return {
      qualifies,
      effectivePrice: deal.price - savings,
      savings,
    };
  }

  private async fetchRegistration(uri: string): Promise<AgentRegistration | null> {
    try {
      const resp = await fetch(uri);
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  private async fetchDealCatalog(endpoint: string): Promise<RawDeal[]> {
    try {
      const resp = await fetch(endpoint);
      if (!resp.ok) return [];
      const data = await resp.json();
      return Array.isArray(data) ? data : data.deals ?? [];
    } catch {
      return [];
    }
  }
}
