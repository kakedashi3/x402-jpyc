export const config = {
  runtime: "edge",
};

import { SUPPORTED_CHAIN_IDS, resolveChain } from "../lib/chain-config.js";
import {
  MIN_SETTLE_JPYC,
  MIN_SETTLE_VALUE,
} from "../lib/payment-validation.js";
import {
  RATE_LIMIT_RPS,
  RATE_LIMIT_BURST_PER_MIN,
} from "../lib/ratelimit.js";
import { budgetStatus } from "../lib/gas-budget.js";
import { corsHeaders, preflight } from "../lib/cors.js";

/**
 * GET /supported — what this facilitator will settle, and on what terms.
 *
 * Two things made this worth adding when the facilitator was opened:
 *
 * 1. A stranger has no other way to find out. With the API key gone, the answer
 *    to "can I point my middleware at you?" has to be fetchable, not emailed.
 * 2. The limits are the price of being open. Rate limits and the sponsored-gas
 *    budget replace the auth wall, so they are published rather than hidden —
 *    a caller that gets a 429 can see exactly which ceiling it hit and what the
 *    escape hatch is (run your own; the image is open source).
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

  const kinds = SUPPORTED_CHAIN_IDS.map((id) => {
    const c = resolveChain(id);
    return {
      x402Version: 2,
      scheme: c.scheme,
      network: c.networkId,
      asset: c.jpycAddress,
      extra: { name: c.eip712Name, version: c.eip712Version },
      // JPYC is 18-decimal on every chain it is deployed to.
      decimals: 18,
      mainnet: c.isMainnet,
    };
  });

  const budgets = await budgetStatus();

  return Response.json(
    {
      kinds,
      // Everything below is the honest cost of having no API key.
      limits: {
        authentication: "none",
        rateLimit: {
          perSecond: RATE_LIMIT_RPS,
          burstPerMinute: RATE_LIMIT_BURST_PER_MIN,
          scopes: ["ip", "payer"],
        },
        sponsoredGas: {
          // Per chain: one settlement costs ~¥0.03 on Kaia and ~¥252 on
          // Ethereum, so a single shared cap would be meaningless.
          perNetwork: budgets.map((b) => ({
            network: b.network,
            settlementsPerDay: b.limit,
            usedToday: b.used,
          })),
          resetsAt: "00:00 UTC",
          note: "yen402 pays the on-chain gas for every settlement. These caps bound that subsidy. Ethereum is intentionally small — L1 gas dwarfs a micropayment. Self-host to raise them.",
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
