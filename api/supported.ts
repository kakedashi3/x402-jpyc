export const config = {
  runtime: "edge",
};

import { SUPPORTED_CHAIN_IDS, resolveChain } from "../lib/chain-config.js";
import {
  MIN_SETTLE_JPYC,
  MIN_SETTLE_VALUE,
} from "../lib/payment-validation.js";
import { RATE_LIMIT_RPS, RATE_LIMIT_BURST_PER_MIN } from "../lib/ratelimit.js";
import { budgetForChain, budgetStatus } from "../lib/gas-budget.js";
import { chainAvailability } from "../lib/gas-balance.js";
import { corsHeaders, preflight } from "../lib/cors.js";

/**
 * GET /supported — what this facilitator will settle, and on what terms.
 *
 * This endpoint reports what the facilitator can ACTUALLY do right now, read
 * from the chain — not what its config file claims. It used to list five chains
 * because five were compiled in, while the hot wallet held zero gas on two of
 * them. A caller would have discovered that at the moment money moved, which is
 * a worse failure than not being listed at all.
 *
 * So `available` is derived from the facilitator's own gas balance on each
 * chain, per request. If we cannot pay, we say we cannot pay.
 *
 * Note for conformance suites: x402 CORE §7.3 makes `/supported` OPTIONAL, so
 * its absence must not fail a facilitator. yen402 previously 404'd here.
 */
export default async function handler(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "GET") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: corsHeaders() },
    );
  }

  const usage = await budgetStatus();
  const usedByChain = new Map(usage.map((u) => [u.chainId, u.used]));

  const networks = await Promise.all(
    SUPPORTED_CHAIN_IDS.map(async (chainId) => {
      const c = resolveChain(chainId);
      const budget = budgetForChain(chainId);
      const gas = await chainAvailability(c, budget > 0);
      return {
        x402Version: 2,
        scheme: c.scheme,
        network: c.networkId,
        asset: c.jpycAddress,
        extra: { name: c.eip712Name, version: c.eip712Version },
        // JPYC is 18-decimal on every chain it is deployed to.
        decimals: 18,
        mainnet: c.isMainnet,

        // Read from the chain, not from config.
        available: gas.available,
        ...(gas.available ? {} : { unavailableReason: gas.reason }),
        sponsoredGas: {
          settlementsPerDay: budget,
          usedToday: usedByChain.get(chainId) ?? 0,
          // How many more we could actually pay for, given the wallet's balance.
          settlementsAffordable: gas.settlesAffordable,
        },
      };
    }),
  );

  return Response.json(
    {
      // Only the networks we can actually settle on. The full list, including
      // what we do not offer and why, is in `networks`.
      kinds: networks.filter((n) => n.available),
      networks,
      // Everything below is the honest cost of having no API key.
      limits: {
        authentication: "none",
        rateLimit: {
          perSecond: RATE_LIMIT_RPS,
          burstPerMinute: RATE_LIMIT_BURST_PER_MIN,
          scopes: ["ip", "payer"],
        },
        sponsoredGas: {
          resetsAt: "00:00 UTC",
          note: "yen402 pays the on-chain gas for every settlement. The per-chain cap bounds the rate; the wallet's balance bounds the loss — see each network's settlementsAffordable, read live from the chain. Ethereum and Avalanche are not offered: L1 gas dwarfs the micropayments x402 exists for. Self-host to enable them.",
        },
        minimumSettlement: {
          jpyc: MIN_SETTLE_JPYC,
          value: MIN_SETTLE_VALUE.toString(),
          note: "Below this, sponsored gas would exceed a sensible fraction of the payment.",
        },
        selfHost: "https://github.com/kakedashi3/x402-jpyc",
      },
    },
    { status: 200, headers: corsHeaders() },
  );
}
