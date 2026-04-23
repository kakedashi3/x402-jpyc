export const config = {
  runtime: "edge",
};

import { createPublicClient, getAddress, http, type Address } from "viem";
import { polygon } from "viem/chains";
import { supabase } from "../lib/supabase";
import {
  validatePayment,
  type PaymentRequestBody,
} from "../lib/payment-validation.js";

const _rpcUrl = process.env.POLYGON_RPC_URL;

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

  if (!publicClient) {
    return json({ error: "Service not configured (RPC)" }, 503);
  }

  let body: PaymentRequestBody;
  try {
    body = (await req.json()) as PaymentRequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const result = await validatePayment(body, recipientAddress, publicClient);
  if (!result.ok) {
    return json({ error: result.error }, result.status);
  }

  const now = new Date().toISOString();
  await Promise.all([
    supabase.from("api_key_usage").insert({
      api_key_id: keyRow.id,
      event: "verify_success",
      created_at: now,
    }),
    supabase
      .from("api_keys")
      .update({ last_used_at: now })
      .eq("id", keyRow.id),
  ]);

  return json({ isValid: true, payer: result.payment.fromAddr });
}
