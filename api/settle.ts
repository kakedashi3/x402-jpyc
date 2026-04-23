export const config = {
  runtime: "edge",
};

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { supabase } from "../lib/supabase";
import { claimNonce } from "../lib/replay.js";

const JPYC_ADDRESS: Address = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";

const EIP3009_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

/* ── Module-level wallet setup ── */

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

/* ── Request types ── */

interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string; // bytes32 hex
}

interface SettleRequestBody {
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

function splitSignature(sig: Hex): { v: number; r: Hex; s: Hex } {
  // 65 bytes = 32 (r) + 32 (s) + 1 (v)
  const raw = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (raw.length !== 130) {
    throw new Error(`Invalid signature length: expected 130 hex chars, got ${raw.length}`);
  }
  const r = `0x${raw.slice(0, 64)}` as Hex;
  const s = `0x${raw.slice(64, 128)}` as Hex;
  let v = parseInt(raw.slice(128, 130), 16);
  // Normalize v: some signers use 0/1 instead of 27/28
  if (v < 27) v += 27;
  return { v, r, s };
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

  // Parse body
  let body: SettleRequestBody;
  try {
    body = (await req.json()) as SettleRequestBody;
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

  // Validate recipient matches DB recipient_address
  if (toAddr !== recipientAddress) {
    return json(
      { error: "Authorization 'to' does not match registered payTo address" },
      400,
    );
  }

  const nonce = auth.nonce as Hex;
  const validAfter = BigInt(auth.validAfter ?? "0");
  const validBefore = BigInt(auth.validBefore ?? "0");

  // Check validBefore hasn't expired
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (validBefore !== 0n && validBefore < now) {
    return json({ error: "Authorization has expired (validBefore)" }, 400);
  }

  // Check nonce hasn't been used (authorizationState)
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
    console.error("[settle] authorizationState check failed:", message);
    return json({ error: "Failed to check authorization state" }, 500);
  }

  // Claim nonce in Redis (prevents TOCTOU between concurrent settle calls)
  const claimed = await claimNonce({
    contractAddress: JPYC_ADDRESS,
    from: fromAddr,
    nonce,
    validBefore,
  });
  if (!claimed) {
    return json({ error: "Authorization nonce already used (replay)" }, 400);
  }

  // Split signature into v, r, s
  let v: number;
  let r: Hex;
  let s: Hex;
  try {
    ({ v, r, s } = splitSignature(signature as Hex));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `Invalid signature: ${message}` }, 400);
  }

  // Execute transferWithAuthorization (use recipientAddress from DB)
  try {
    const txHash = await walletClient.writeContract({
      address: JPYC_ADDRESS,
      abi: EIP3009_ABI,
      functionName: "transferWithAuthorization",
      args: [fromAddr, recipientAddress, value, validAfter, validBefore, nonce, v, r, s],
    });

    const now = new Date().toISOString();

    console.log(JSON.stringify({
      event: "settle_success",
      txHash,
      amount: paymentRequirements.amount,
      asset: paymentRequirements.asset,
      payTo: recipientAddress,
      from: auth.from,
      network: "eip155:137",
      timestamp: now,
    }));

    // Log usage and update last_used_at in parallel
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

    return json({ success: true, txHash, network: "eip155:137" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[settle] transferWithAuthorization failed:", message);
    console.log(JSON.stringify({
      event: "settle_failed",
      reason: message,
      timestamp: new Date().toISOString(),
    }));
    return json({ success: false, error: "Transaction execution failed" }, 500);
  }
}
