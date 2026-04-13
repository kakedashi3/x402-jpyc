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
  signature: string; // 65-byte hex (r + s + v)
}

interface VerifyRequestBody {
  paymentPayload: {
    x402Version: number;
    scheme: string;
    network: string;
    payload: {
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

  // API key auth
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return json({ error: "Service not configured (API_KEY)" }, 503);
  }
  const provided = req.headers.get("x-api-key");
  if (!provided || provided !== apiKey) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (!walletClient || !publicClient) {
    return json({ error: "Service not configured (wallet/RPC)" }, 503);
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

  // Validate required authorization fields
  if (!auth.from || !auth.to || !auth.value || !auth.nonce || !auth.signature) {
    return json(
      { error: "Missing authorization fields: from, to, value, nonce, signature are required" },
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
    console.error("[verify] authorizationState check failed:", message);
    return json({ error: "Failed to check authorization state" }, 500);
  }

  // Split signature into v, r, s
  let v: number;
  let r: Hex;
  let s: Hex;
  try {
    ({ v, r, s } = splitSignature(auth.signature as Hex));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: `Invalid signature: ${message}` }, 400);
  }

  // Execute transferWithAuthorization
  try {
    const txHash = await walletClient.writeContract({
      address: JPYC_ADDRESS,
      abi: EIP3009_ABI,
      functionName: "transferWithAuthorization",
      args: [fromAddr, toAddr, value, validAfter, validBefore, nonce, v, r, s],
    });

    console.log(JSON.stringify({
      event: "verify_success",
      txHash,
      amount: paymentRequirements.amount,
      asset: paymentRequirements.asset,
      payTo: paymentRequirements.payTo,
      from: auth.from,
      network: "eip155:137",
      timestamp: new Date().toISOString(),
    }));

    return json({ isValid: true, txHash });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[verify] transferWithAuthorization failed:", message);
    console.log(JSON.stringify({
      event: "verify_failed",
      reason: message,
      timestamp: new Date().toISOString(),
    }));
    return json({ isValid: false, error: "Transaction execution failed" }, 500);
  }
}
