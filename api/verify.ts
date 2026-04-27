export const config = {
  runtime: "edge",
};

import { getAddress, type Address } from "viem";
import { supabase } from "../lib/supabase";
import {
  getFacilitatorAccount,
  getPublicClient,
  resolveChain,
  ChainNotSupportedError,
  type ChainConfig,
} from "../lib/chain-config.js";
import {
  simulateTransferWithAuthorization,
  validatePayment,
  type PaymentRequestBody,
} from "../lib/payment-validation.js";
import { logUsage } from "../lib/usage-log.js";

const _facilitatorAccount = getFacilitatorAccount();

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
      return json(
        { error: err.message, code: "invalid_chain_id" },
        400,
      );
    }
    throw err;
  }

  if (!_facilitatorAccount) {
    return json(
      { error: "Service not configured (facilitator key)" },
      503,
    );
  }

  let publicClient;
  try {
    publicClient = getPublicClient(chain);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `Service not configured: ${message}` }, 503);
  }

  let body: PaymentRequestBody;
  try {
    body = (await req.json()) as PaymentRequestBody;
  } catch {
    return json({ error: "Invalid JSON body", code: "invalid_request" }, 400);
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

  const sim = await simulateTransferWithAuthorization(
    result.payment,
    publicClient,
    _facilitatorAccount.address,
    { chain },
  );
  if (!sim.ok) {
    return json({ error: sim.error, code: sim.code }, sim.status);
  }

  logUsage({ apiKeyId: keyRow.id, event: "verify_success" });

  return json({ isValid: true, payer: result.payment.fromAddr });
}
