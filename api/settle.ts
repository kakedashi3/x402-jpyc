export const config = {
  runtime: "edge",
};

import { type Hex } from "viem";
import { claimNonce } from "../lib/replay.js";
import {
  ChainNotSupportedError,
  getFacilitatorAccount,
  getPublicClient,
  getWalletClient,
  resolveChainByNetworkId,
  type ChainConfig,
} from "../lib/chain-config.js";
import {
  TRANSFER_WITH_AUTHORIZATION_ABI,
  splitEip3009Signature,
  validatePayment,
  type PaymentRequestBody,
} from "../lib/payment-validation.js";
import { notifyTagamie } from "../lib/tagamie-webhook.js";
import { checkRateLimit, callerIp } from "../lib/ratelimit.js";
import { reserveSettlement, releaseSettlement } from "../lib/gas-budget.js";
import { corsHeaders, preflight } from "../lib/cors.js";
import { networkFromBody } from "../lib/request-network.js";

const _facilitatorAccount = getFacilitatorAccount();

function json(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return Response.json(data, {
    status,
    headers: { ...corsHeaders(), ...(headers ?? {}) },
  });
}

/**
 * POST /settle — open, unauthenticated.
 *
 * This is where the facilitator spends its own gas, so this is where the API
 * key used to sit. The key was the wrong control: it could not stop theft (the
 * recipient is inside the buyer's EIP-3009 signature, so a payment cannot be
 * redirected) and it did stop adoption (a stranger could not point their x402
 * middleware at yen402 without registering first). The gas is now defended the
 * way the rest of the x402 directory defends it — a rate limit and a published
 * daily budget — and the budget is a bound we can put in the docs.
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
        success: false,
        errorReason: "rate_limited",
        transaction: "",
        error: `Rate limit exceeded (${rl.limit} per ${rl.window} per ${rl.scope}). Run your own facilitator for unlimited use — the image is open source.`,
        code: "rate_limited",
      },
      429,
      { "retry-after": String(rl.retryAfter ?? 1) },
    );
  }

  let body: PaymentRequestBody;
  try {
    body = (await req.json()) as PaymentRequestBody;
  } catch {
    return json(
      {
        success: false,
        errorReason: "invalid_request",
        transaction: "",
        error: "Invalid JSON body",
        code: "invalid_request",
      },
      400,
    );
  }

  // Chain comes from the payment's own `network`, not from a chain id bound to
  // an API key row. `validatePayment` asserts payload and requirements agree.
  let chain: ChainConfig;
  try {
    chain = resolveChainByNetworkId(networkFromBody(body));
  } catch (err) {
    if (err instanceof ChainNotSupportedError) {
      return json(
        {
          success: false,
          errorReason: "invalid_network",
          transaction: "",
          error:
            "Unsupported network. yen402 settles JPYC on Ethereum, Polygon, Polygon Amoy, Avalanche and Kaia.",
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
  let walletClient;
  try {
    publicClient = getPublicClient(chain);
    walletClient = getWalletClient(chain, _facilitatorAccount);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `Service not configured: ${message}` }, 503);
  }

  const result = await validatePayment(body, publicClient, chain);
  if (!result.ok) {
    return json(
      {
        success: false,
        errorReason: result.code,
        transaction: "",
        network: chain.networkId,
        error: result.error,
        code: result.code,
      },
      result.status,
    );
  }

  const { fromAddr, toAddr, value, validAfter, validBefore, nonce, signature } =
    result.payment;

  // Claim nonce in Redis (prevents TOCTOU between concurrent settle calls).
  // Default fail-closed: if Redis is unreachable, return 503 so the caller
  // can retry rather than risk a double broadcast. Operators can opt into
  // legacy fail-open via REPLAY_FAIL_OPEN=true.
  const claim = await claimNonce({
    chainId: chain.chainId,
    contractAddress: chain.jpycAddress,
    from: fromAddr,
    nonce,
    validBefore,
  });
  if (!claim.ok) {
    if (claim.mode === "fail_closed") {
      return json(
        {
          success: false,
          errorReason: "service_unavailable",
          payer: fromAddr,
          transaction: "",
          network: chain.networkId,
          error: "Replay-protection store unavailable; please retry",
          code: "service_unavailable",
        },
        503,
      );
    }
    return json(
      {
        success: false,
        errorReason: "nonce_already_used",
        payer: fromAddr,
        transaction: "",
        network: chain.networkId,
        error: "Authorization nonce already used (replay)",
        code: "nonce_already_used",
      },
      400,
    );
  }
  const replayHeader = claim.mode === "fail_open" ? "degraded" : "normal";

  // Reserve one settlement from today's sponsored-gas budget. This is the hard
  // bound on what a stranger can cost us now that there is no API key: the loss
  // is capped at DAILY_SETTLE_BUDGET settlements of gas, and that number is
  // published in /supported and the README rather than hidden behind an auth
  // wall. Fails closed — we never broadcast gas we cannot account for.
  const budget = await reserveSettlement();
  if (!budget.ok) {
    const exhausted = budget.mode === "normal";
    return json(
      {
        success: false,
        errorReason: exhausted ? "budget_exhausted" : "service_unavailable",
        payer: fromAddr,
        transaction: "",
        network: chain.networkId,
        error: exhausted
          ? `Daily sponsored-gas budget exhausted (${budget.limit} settlements/day, resets 00:00 UTC). Run your own facilitator for unlimited settlement — the image is open source.`
          : "Gas-budget store unavailable; please retry",
        code: exhausted ? "budget_exhausted" : "service_unavailable",
      },
      exhausted ? 429 : 503,
    );
  }

  let v: number;
  let r: Hex;
  let s: Hex;
  try {
    ({ v, r, s } = splitEip3009Signature(signature));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Never broadcast — hand the budget reservation back.
    await releaseSettlement();
    return json(
      {
        success: false,
        errorReason: "invalid_signature",
        payer: fromAddr,
        transaction: "",
        network: chain.networkId,
        error: `Invalid signature: ${message}`,
        code: "invalid_signature",
      },
      400,
    );
  }

  try {
    const txHash = await walletClient.writeContract({
      address: chain.jpycAddress,
      abi: TRANSFER_WITH_AUTHORIZATION_ABI,
      functionName: "transferWithAuthorization",
      args: [
        fromAddr,
        toAddr,
        value,
        validAfter,
        validBefore,
        nonce,
        v,
        r,
        s,
      ],
      account: _facilitatorAccount,
      chain: chain.viemChain,
    });

    const now = new Date().toISOString();

    console.log(
      JSON.stringify({
        event: "settle_success",
        txHash,
        amount: value.toString(),
        asset: chain.jpycAddress,
        payTo: toAddr,
        from: fromAddr,
        network: chain.networkId,
        timestamp: now,
      }),
    );

    // Mainnet only — Tagamie's chain enum doesn't include testnets.
    // isMainnet filters out amoy at runtime; the cast tells TS that
    // chain.name is one of Tagamie's accepted mainnet names.
    if (chain.isMainnet) {
      // Cross-Layer Context v1: forwarded opaquely if the caller included it
      // in the settle request body. Facilitator does no inner validation.
      // Tagamie applies its own Zod schema on receipt
      // (app/api/webhooks/settle/route.ts crossLayerContextSchema).
      const ctx =
        body.context && typeof body.context === "object"
          ? (body.context as import("../lib/cross-layer-context.js").CrossLayerContext)
          : undefined;

      await notifyTagamie({
        txHash,
        chain: chain.name as "polygon" | "ethereum" | "avalanche" | "kaia",
        payTo: toAddr,
        payer: fromAddr,
        amountMinor: value.toString(),
        asset: "JPYC",
        occurredAt: now,
        context: ctx,
      });
    }

    return json(
      {
        success: true,
        payer: fromAddr,
        transaction: txHash,
        txHash,
        network: chain.networkId,
      },
      200,
      { "X-Replay-Protection": replayHeader },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[settle] transferWithAuthorization failed:", message);
    console.log(
      JSON.stringify({
        event: "settle_failed",
        reason: message,
        timestamp: new Date().toISOString(),
      }),
    );
    return json(
      {
        success: false,
        errorReason: "transaction_failed",
        payer: fromAddr,
        transaction: "",
        network: chain.networkId,
        error: "Transaction execution failed",
      },
      500,
    );
  }
}
