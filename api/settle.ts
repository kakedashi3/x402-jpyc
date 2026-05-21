export const config = {
  runtime: "edge",
};

import { getAddress, type Address, type Hex } from "viem";
import { supabase } from "../lib/supabase";
import { claimNonce } from "../lib/replay.js";
import { logUsage } from "../lib/usage-log.js";
import {
  ChainNotSupportedError,
  getFacilitatorAccount,
  getPublicClient,
  getWalletClient,
  resolveChain,
  type ChainConfig,
} from "../lib/chain-config.js";
import {
  TRANSFER_WITH_AUTHORIZATION_ABI,
  splitEip3009Signature,
  validatePayment,
  type PaymentRequestBody,
} from "../lib/payment-validation.js";
import { notifyTagamie } from "../lib/tagamie-webhook.js";

const _facilitatorAccount = getFacilitatorAccount();

function json(
  data: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return Response.json(data, { status, headers });
}

async function hashApiKey(apiKey: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(apiKey),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const providedKey = req.headers.get("x-api-key");
  if (!providedKey) {
    return json({ error: "Unauthorized" }, 401);
  }

  const keyHash = await hashApiKey(providedKey);
  const { data: keyRow, error: keyError } = await supabase
    .from("api_keys")
    .select("id, user_id, recipient_address, chain_id")
    .eq("api_key_hash", keyHash)
    .eq("is_active", true)
    .single();

  if (keyError || !keyRow) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Resolve the allowlist of payTo addresses for this api_key. Prefer the
  // api_key_recipients table; fall back to api_keys.recipient_address for
  // rows that pre-date the backfill or somehow skipped it.
  const { data: recipientRows } = await supabase
    .from("api_key_recipients")
    .select("recipient_address")
    .eq("api_key_id", keyRow.id)
    .eq("is_active", true);

  const allowlist: Address[] =
    recipientRows && recipientRows.length > 0
      ? recipientRows.map((r: { recipient_address: string }) =>
          getAddress(r.recipient_address),
        )
      : [getAddress(keyRow.recipient_address)];

  const requestedChainId = (keyRow.chain_id as number | null) ?? 137;

  let chain: ChainConfig;
  try {
    chain = resolveChain(requestedChainId);
  } catch (err) {
    if (err instanceof ChainNotSupportedError) {
      return json(
        {
          success: false,
          errorReason: "invalid_chain_id",
          transaction: "",
          error: err.message,
          code: "invalid_chain_id",
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

  let body: PaymentRequestBody;
  try {
    body = (await req.json()) as PaymentRequestBody;
  } catch {
    return json(
      {
        success: false,
        errorReason: "invalid_request",
        transaction: "",
        network: chain.networkId,
        error: "Invalid JSON body",
        code: "invalid_request",
      },
      400,
    );
  }

  const result = await validatePayment(
    body,
    allowlist,
    publicClient,
    chain,
  );
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

  let v: number;
  let r: Hex;
  let s: Hex;
  try {
    ({ v, r, s } = splitEip3009Signature(signature));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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

    logUsage({ apiKeyId: keyRow.id, event: "settle_success", createdAt: now });

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
