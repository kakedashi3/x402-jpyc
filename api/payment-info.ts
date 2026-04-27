export const config = {
  runtime: "edge",
};

import { getAddress } from "viem";
import { supabase } from "../lib/supabase";
import {
  ChainNotSupportedError,
  resolveChain,
} from "../lib/chain-config.js";

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
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const providedKey = req.headers.get("x-api-key");
  if (!providedKey) {
    return json({ error: "Unauthorized" }, 401);
  }

  const keyHash = await hashApiKey(providedKey);
  const { data: keyRow, error: keyError } = await supabase
    .from("api_keys")
    .select("recipient_address, chain_id")
    .eq("api_key_hash", keyHash)
    .eq("is_active", true)
    .single();

  if (keyError || !keyRow) {
    return json({ error: "Unauthorized" }, 401);
  }

  const requestedChainId = (keyRow.chain_id as number | null) ?? 137;
  let chain;
  try {
    chain = resolveChain(requestedChainId);
  } catch (err) {
    if (err instanceof ChainNotSupportedError) {
      return json({ error: err.message, code: "invalid_chain_id" }, 400);
    }
    throw err;
  }

  return json({
    recipientAddress: getAddress(keyRow.recipient_address),
    network: chain.networkId,
    chainId: chain.chainId,
    token: chain.jpycAddress,
    decimals: chain.jpycDecimals,
  });
}
