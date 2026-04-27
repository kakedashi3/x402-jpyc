export const config = {
  runtime: "edge",
};

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { supabase } from "../lib/supabase";
import { claimNonce } from "../lib/replay.js";
import {
  JPYC,
  TRANSFER_WITH_AUTHORIZATION_ABI,
  splitEip3009Signature,
  validatePayment,
  type PaymentRequestBody,
} from "../lib/payment-validation.js";

const _privateKey = process.env.FACILITATOR_PRIVATE_KEY;
const _rpcUrl = process.env.POLYGON_RPC_URL;

const _key = _privateKey
  ? ((_privateKey.startsWith("0x") ? _privateKey : `0x${_privateKey}`) as Hex)
  : null;

const _account = _key ? privateKeyToAccount(_key) : null;

const walletClient =
  _account && _rpcUrl
    ? createWalletClient({
        account: _account,
        chain: polygon,
        transport: http(_rpcUrl),
      })
    : null;

const publicClient = _rpcUrl
  ? createPublicClient({ chain: polygon, transport: http(_rpcUrl) })
  : null;

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
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
    .select("id, user_id, recipient_address")
    .eq("api_key_hash", keyHash)
    .eq("is_active", true)
    .single();

  if (keyError || !keyRow) {
    return json({ error: "Unauthorized" }, 401);
  }

  const recipientAddress: Address = getAddress(keyRow.recipient_address);

  if (!walletClient || !publicClient) {
    return json({ error: "Service not configured (wallet/RPC)" }, 503);
  }

  let body: PaymentRequestBody;
  try {
    body = (await req.json()) as PaymentRequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const result = await validatePayment(body, recipientAddress, publicClient);
  if (!result.ok) {
    return json({ error: result.error, code: result.code }, result.status);
  }

  const { fromAddr, value, validAfter, validBefore, nonce, signature } =
    result.payment;

  // Claim nonce in Redis (prevents TOCTOU between concurrent settle calls)
  const claimed = await claimNonce({
    contractAddress: JPYC.ADDRESS,
    from: fromAddr,
    nonce,
    validBefore,
  });
  if (!claimed) {
    return json(
      {
        error: "Authorization nonce already used (replay)",
        code: "nonce_already_used",
      },
      400,
    );
  }

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
      address: JPYC.ADDRESS,
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
    });

    const now = new Date().toISOString();

    console.log(
      JSON.stringify({
        event: "settle_success",
        txHash,
        amount: value.toString(),
        asset: JPYC.ADDRESS,
        payTo: recipientAddress,
        from: fromAddr,
        network: JPYC.NETWORK,
        timestamp: now,
      }),
    );

    await Promise.all([
      supabase.from("api_key_usage").insert({
        api_key_id: keyRow.id,
        event: "settle_success",
        created_at: now,
      }),
      supabase
        .from("api_keys")
        .update({ last_used_at: now })
        .eq("id", keyRow.id),
    ]);

    return json({ success: true, txHash, network: JPYC.NETWORK });
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
