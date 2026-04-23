export const config = {
  runtime: "edge",
};

import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { polygon } from "viem/chains";
import { supabase } from "../lib/supabase";

const JPYC_ADDRESS: Address = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";
const JPYC_CHAIN_ID = 137;

const EIP3009_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

const EIP712_DOMAIN = {
  name: "JPY Coin",
  version: "1",
  chainId: JPYC_CHAIN_ID,
  verifyingContract: JPYC_ADDRESS,
} as const;

const EIP712_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/* ── Module-level public client ── */

const _rpcUrl = process.env.POLYGON_RPC_URL;

const publicClient = _rpcUrl
  ? createPublicClient({ chain: polygon, transport: http(_rpcUrl) })
  : null;

/* ── Request types ── */

interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string; // bytes32 hex
}

interface VerifyRequestBody {
  paymentPayload: {
    x402Version: number;
    scheme: string;
    network: string;
    payload: {
      signature: string; // 65-byte hex (r + s + v)
      authorization: Authorization;
    };
  };
  paymentRequirements: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
  };
}

/* ── Helpers ── */

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

/* ── Handler ── */

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // API key auth via Supabase
  const providedKey = req.headers.get("x-api-key");
  if (!providedKey) {
    return json({ error: "Unauthorized" }, 401);
  }

  const keyHash = await hashApiKey(providedKey);
  const { data: keyRow, error: keyError } = await supabase
    .from("api_keys")
    .select("id, user_id")
    .eq("api_key_hash", keyHash)
    .eq("is_active", true)
    .single();

  if (keyError || !keyRow) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (!publicClient) {
    return json({ error: "Service not configured (RPC)" }, 503);
  }

  // Parse body
  let body: VerifyRequestBody;
  try {
    body = (await req.json()) as VerifyRequestBody;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { paymentPayload, paymentRequirements } = body;

  if (!paymentPayload?.payload?.authorization || !paymentRequirements) {
    return json(
      { error: "Missing required fields: paymentPayload.payload.authorization, paymentRequirements" },
      400,
    );
  }

  const auth = paymentPayload.payload.authorization;
  const signature = paymentPayload.payload.signature;

  // Validate required fields
  if (!auth.from || !auth.to || !auth.value || !auth.nonce || !signature) {
    return json(
      { error: "Missing fields: from, to, value, nonce, and payload.signature are required" },
      400,
    );
  }

  // Validate addresses
  let fromAddr: Address;
  let toAddr: Address;
  try {
    fromAddr = getAddress(auth.from);
    toAddr = getAddress(auth.to);
  } catch {
    return json({ error: "Invalid from or to address" }, 400);
  }

  // Validate asset is JPYC
  try {
    if (getAddress(paymentRequirements.asset) !== getAddress(JPYC_ADDRESS)) {
      return json(
        { error: `Unsupported asset: expected JPYC (${JPYC_ADDRESS})` },
        400,
      );
    }
  } catch {
    return json({ error: "Invalid asset address" }, 400);
  }

  // Validate amount
  let value: bigint;
  try {
    value = BigInt(auth.value);
    if (value <= 0n) throw new Error();
  } catch {
    return json({ error: "Invalid authorization value" }, 400);
  }

  const requiredAmount = BigInt(paymentRequirements.amount);
  if (value < requiredAmount) {
    return json(
      { error: `Authorization value ${value} is less than required ${requiredAmount}` },
      400,
    );
  }

  // Validate recipient matches payTo
  if (toAddr !== getAddress(paymentRequirements.payTo)) {
    return json(
      { error: "Authorization 'to' does not match paymentRequirements.payTo" },
      400,
    );
  }

  const nonce = auth.nonce as Hex;
  const validAfter = BigInt(auth.validAfter ?? "0");
  const validBefore = BigInt(auth.validBefore ?? "0");

  // Check validBefore hasn't expired
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (validBefore !== 0n && validBefore < nowSec) {
    return json({ error: "Authorization has expired (validBefore)" }, 400);
  }

  // Check nonce hasn't been used on-chain (authorizationState)
  try {
    const used = await publicClient.readContract({
      address: JPYC_ADDRESS,
      abi: EIP3009_ABI,
      functionName: "authorizationState",
      args: [fromAddr, nonce],
    });
    if (used) {
      return json({ error: "Authorization nonce already used (replay)" }, 400);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[verify] authorizationState check failed:", message);
    return json({ error: "Failed to check authorization state" }, 500);
  }

  // Verify EIP-712 signature locally
  let sigValid: boolean;
  try {
    sigValid = await verifyTypedData({
      address: fromAddr,
      domain: EIP712_DOMAIN,
      types: EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: fromAddr,
        to: toAddr,
        value,
        validAfter,
        validBefore,
        nonce,
      },
      signature: signature as Hex,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `Invalid signature: ${message}` }, 400);
  }

  if (!sigValid) {
    return json({ error: "Signature does not match 'from' address" }, 400);
  }

  // Log usage
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

  return json({ isValid: true, payer: fromAddr });
}
