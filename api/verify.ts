export const config = {
  runtime: "edge",
};

import {
  getFacilitatorAccount,
  getPublicClient,
  resolveChainByNetworkId,
  ChainNotSupportedError,
  type ChainConfig,
} from "../lib/chain-config.js";
import {
  simulateTransferWithAuthorization,
  validatePayment,
  type PaymentRequestBody,
} from "../lib/payment-validation.js";
import { checkRateLimit, callerIp } from "../lib/ratelimit.js";
import { corsHeaders, preflight } from "../lib/cors.js";
import { networkFromBody } from "../lib/request-network.js";

const _facilitatorAccount = getFacilitatorAccount();

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders() });
}

/**
 * POST /verify — open, unauthenticated.
 *
 * There is no API key. The key yen402 used to require never protected funds:
 * `authorization.to` sits inside the buyer's EIP-3009 signature, so the
 * facilitator cannot redirect a payment. It only protected sponsored gas, and
 * `/verify` spends none — it is a read-only simulation. Abuse of the endpoint
 * itself is bounded by the rate limiter; `/settle` additionally holds the
 * daily gas budget.
 *
 * The chain now comes from the payment's own `network` (e.g. `eip155:137`)
 * rather than from a chain id bound to an API key row, which is what let a
 * single seller only ever use one chain.
 */
export default async function handler(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const rl = await checkRateLimit({ ip: callerIp(req) });
  if (!rl.ok) {
    return json(
      {
        isValid: false,
        invalidReason: "rate_limited",
        error: `Rate limit exceeded (${rl.limit} per ${rl.window} per ${rl.scope}). Run your own facilitator for unlimited use — the image is open source.`,
        code: "rate_limited",
      },
      429,
    );
  }

  let body: PaymentRequestBody;
  try {
    body = (await req.json()) as PaymentRequestBody;
  } catch {
    return json(
      {
        isValid: false,
        invalidReason: "invalid_request",
        error: "Invalid JSON body",
        code: "invalid_request",
      },
      400,
    );
  }

  let chain: ChainConfig;
  try {
    chain = resolveChainByNetworkId(networkFromBody(body));
  } catch (err) {
    if (err instanceof ChainNotSupportedError) {
      return json(
        {
          isValid: false,
          invalidReason: "invalid_network",
          error: `Unsupported network. yen402 settles JPYC on Ethereum, Polygon, Polygon Amoy, Avalanche and Kaia.`,
          code: "invalid_network",
        },
        400,
      );
    }
    throw err;
  }

  if (!_facilitatorAccount) {
    return json({ error: "Service not configured (facilitator key)" }, 503);
  }

  let publicClient;
  try {
    publicClient = getPublicClient(chain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `Service not configured: ${message}` }, 503);
  }

  const result = await validatePayment(body, publicClient, chain);
  if (!result.ok) {
    return json(
      {
        isValid: false,
        invalidReason: result.code,
        error: result.error,
        code: result.code,
      },
      result.status,
    );
  }

  const sim = await simulateTransferWithAuthorization(
    result.payment,
    publicClient,
    _facilitatorAccount.address,
    { chain },
  );
  if (!sim.ok) {
    return json(
      {
        isValid: false,
        invalidReason: sim.code,
        payer: result.payment.fromAddr,
        error: sim.error,
        code: sim.code,
      },
      sim.status,
    );
  }

  return json({ isValid: true, payer: result.payment.fromAddr });
}
