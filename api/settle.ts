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

  const recipientAddress: Address = getAddress(keyRow.recipient_address);
  const requestedChainId = (keyRow.chain_id as number | null) ?? 137;

  let chain: ChainConfig;
  try {
    chain = resolveChain(requestedChainId);
  } catch (err) {
    if (err instanceof ChainNotSupportedError) {
      return json({ error: err.message, code: "invalid_chain_id" }, 400);
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
    return json({ error: "Invalid JSON body" }, 400);
  }

  const result = await validatePayment(
    body,
    recipientAddress,
    publicClient,
    chain,
  );
  if (!result.ok) {
    return json({ error: result.error, code: result.code }, result.status);
  }

  const { fromAddr, value, validAfter, validBefore, nonce, signature } =
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
          error: "Replay-protection store unavailable; please retry",
          code: "service_unavailable",
        },
        503,
      );
    }
    return json(
      {
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
      { error: `Invalid signature: ${message}`, code: "invalid_signature" },
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
        recipientAddress,
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
        payTo: recipientAddress,
        from: fromAddr,
        network: chain.networkId,
        timestamp: now,
      }),
    );

    logUsage({ apiKeyId: keyRow.id, event: "settle_success", createdAt: now });

    return json(
      { success: true, txHash, network: chain.networkId },
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
    return json({ success: false, error: "Transaction execution failed" }, 500);
  }
}
