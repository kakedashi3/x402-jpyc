import {
  getAddress,
  parseAbi,
  parseSignature,
  verifyTypedData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { POLYGON, type ChainConfig } from "./chain-config.js";

/**
 * @deprecated Prefer importing chain configs from `./chain-config`.
 *   `JPYC` is kept as a Polygon-mainnet alias so older callers and
 *   tests continue to compile.
 */
export const JPYC = {
  ADDRESS: POLYGON.jpycAddress,
  CHAIN_ID: POLYGON.chainId,
  NETWORK: POLYGON.networkId,
  SCHEME: POLYGON.scheme,
  EIP712_NAME: POLYGON.eip712Name,
  EIP712_VERSION: POLYGON.eip712Version,
} as const;

const SUPPORTED_X402_VERSIONS = new Set([1, 2]);

const AUTH_STATE_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

export const TRANSFER_WITH_AUTHORIZATION_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

function buildEip712Domain(chain: ChainConfig) {
  return {
    name: chain.eip712Name,
    version: chain.eip712Version,
    chainId: chain.chainId,
    verifyingContract: chain.jpycAddress,
  } as const;
}

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

export type PaymentErrorCode =
  | "invalid_request"
  | "invalid_signature"
  | "invalid_chain_id"
  | "invalid_pay_to"
  | "invalid_amount"
  | "invalid_asset"
  | "invalid_scheme"
  | "invalid_network"
  | "invalid_x402_version"
  | "invalid_extra"
  | "invalid_address"
  | "authorization_expired"
  | "authorization_not_yet_valid"
  | "nonce_already_used"
  | "invalid_nonce_format"
  | "simulation_failed"
  | "simulation_timeout"
  | "facilitator_insufficient_native_balance"
  | "rpc_unavailable";

interface Authorization {
  from?: string;
  to?: string;
  value?: string;
  validAfter?: string;
  validBefore?: string;
  nonce?: string;
}

export interface PaymentRequestBody {
  paymentPayload?: {
    x402Version?: number;
    scheme?: string;
    network?: string;
    payload?: {
      signature?: string;
      authorization?: Authorization;
    };
  };
  paymentRequirements?: {
    scheme?: string;
    network?: string;
    asset?: string;
    amount?: string;
    payTo?: string;
    extra?: {
      name?: string;
      version?: string;
    };
  };
}

export interface ValidatedPayment {
  fromAddr: Address;
  toAddr: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}

export type ValidationResult =
  | { ok: true; payment: ValidatedPayment }
  | {
      ok: false;
      status: number;
      code: PaymentErrorCode;
      error: string;
    };

export type SimulationResult =
  | { ok: true; gasEstimate: bigint }
  | {
      ok: false;
      status: number;
      code: PaymentErrorCode;
      error: string;
    };

function fail(
  status: number,
  code: PaymentErrorCode,
  error: string,
): ValidationResult {
  return { ok: false, status, code, error };
}

function simFail(
  status: number,
  code: PaymentErrorCode,
  error: string,
): SimulationResult {
  return { ok: false, status, code, error };
}

const NONCE_HEX_REGEX = /^0x[0-9a-fA-F]{64}$/;

export function isValidNonceFormat(nonce: unknown): nonce is Hex {
  return typeof nonce === "string" && NONCE_HEX_REGEX.test(nonce);
}

/**
 * Split a 65-byte EIP-3009 signature into the (v, r, s) tuple expected
 * by `transferWithAuthorization`. Backed by viem's `parseSignature`,
 * which canonicalizes legacy v=0/1 → yParity and decodes EIP-2098
 * compact 64-byte forms.
 *
 * Always returns v as 27 or 28 (EIP-3009's contract takes uint8 v).
 * Throws with a "signature length" / "signature" message on malformed
 * input so callers can surface a stable `invalid_signature` code.
 */
export function splitEip3009Signature(sig: Hex): {
  v: number;
  r: Hex;
  s: Hex;
} {
  let parsed;
  try {
    parsed = parseSignature(sig);
  } catch (err) {
    const inner = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid signature length or format: ${inner}`);
  }
  return { v: 27 + parsed.yParity, r: parsed.r, s: parsed.s };
}

export async function validatePayment(
  body: PaymentRequestBody,
  recipientAddress: Address,
  publicClient: PublicClient,
  chain: ChainConfig = POLYGON,
): Promise<ValidationResult> {
  const { paymentPayload, paymentRequirements } = body;

  if (!paymentPayload?.payload?.authorization || !paymentRequirements) {
    return fail(
      400,
      "invalid_request",
      "Missing required fields: paymentPayload.payload.authorization, paymentRequirements",
    );
  }

  const version = paymentPayload.x402Version;
  if (typeof version !== "number" || !SUPPORTED_X402_VERSIONS.has(version)) {
    return fail(
      400,
      "invalid_x402_version",
      `Unsupported x402Version: ${version} (expected 1 or 2)`,
    );
  }

  if (paymentPayload.scheme !== chain.scheme) {
    return fail(
      400,
      "invalid_scheme",
      `Unsupported paymentPayload.scheme: ${paymentPayload.scheme} (expected ${chain.scheme})`,
    );
  }
  if (paymentRequirements.scheme !== chain.scheme) {
    return fail(
      400,
      "invalid_scheme",
      `Unsupported paymentRequirements.scheme: ${paymentRequirements.scheme} (expected ${chain.scheme})`,
    );
  }

  if (paymentPayload.network !== chain.networkId) {
    return fail(
      400,
      "invalid_chain_id",
      `Unsupported paymentPayload.network: ${paymentPayload.network} (expected ${chain.networkId})`,
    );
  }
  if (paymentRequirements.network !== chain.networkId) {
    return fail(
      400,
      "invalid_chain_id",
      `Unsupported paymentRequirements.network: ${paymentRequirements.network} (expected ${chain.networkId})`,
    );
  }

  const extra = paymentRequirements.extra;
  if (extra) {
    if (extra.name !== undefined && extra.name !== chain.eip712Name) {
      return fail(
        400,
        "invalid_extra",
        `paymentRequirements.extra.name mismatch: "${extra.name}" (expected "${chain.eip712Name}")`,
      );
    }
    if (extra.version !== undefined && extra.version !== chain.eip712Version) {
      return fail(
        400,
        "invalid_extra",
        `paymentRequirements.extra.version mismatch: "${extra.version}" (expected "${chain.eip712Version}")`,
      );
    }
  }

  const auth = paymentPayload.payload.authorization;
  const signature = paymentPayload.payload.signature;

  if (!auth.from || !auth.to || !auth.value || !auth.nonce || !signature) {
    return fail(
      400,
      "invalid_request",
      "Missing fields: from, to, value, nonce, and payload.signature are required",
    );
  }

  if (!isValidNonceFormat(auth.nonce)) {
    return fail(
      400,
      "invalid_nonce_format",
      "Authorization nonce must be 0x-prefixed bytes32 (32 bytes / 64 hex chars)",
    );
  }

  let fromAddr: Address;
  let toAddr: Address;
  try {
    fromAddr = getAddress(auth.from);
    toAddr = getAddress(auth.to);
  } catch {
    return fail(400, "invalid_address", "Invalid from or to address");
  }

  if (!paymentRequirements.asset) {
    return fail(400, "invalid_asset", "Missing paymentRequirements.asset");
  }
  try {
    if (getAddress(paymentRequirements.asset) !== getAddress(chain.jpycAddress)) {
      return fail(
        400,
        "invalid_asset",
        `Unsupported asset: expected JPYC (${chain.jpycAddress}) on ${chain.name}`,
      );
    }
  } catch {
    return fail(400, "invalid_asset", "Invalid asset address");
  }

  if (!paymentRequirements.payTo) {
    return fail(400, "invalid_pay_to", "Missing paymentRequirements.payTo");
  }
  let declaredPayTo: Address;
  try {
    declaredPayTo = getAddress(paymentRequirements.payTo);
  } catch {
    return fail(
      400,
      "invalid_pay_to",
      "Invalid paymentRequirements.payTo address",
    );
  }
  if (declaredPayTo !== recipientAddress) {
    return fail(
      400,
      "invalid_pay_to",
      "paymentRequirements.payTo does not match registered payTo address",
    );
  }
  if (toAddr !== recipientAddress) {
    return fail(
      400,
      "invalid_pay_to",
      "Authorization 'to' does not match registered payTo address",
    );
  }

  let value: bigint;
  try {
    if (typeof auth.value !== "string") throw new Error("non-string value");
    value = BigInt(auth.value);
    if (value <= 0n) throw new Error();
  } catch {
    return fail(400, "invalid_amount", "Invalid authorization value");
  }

  if (!paymentRequirements.amount) {
    return fail(400, "invalid_amount", "Missing paymentRequirements.amount");
  }
  let requiredAmount: bigint;
  try {
    requiredAmount = BigInt(paymentRequirements.amount);
    if (requiredAmount <= 0n) throw new Error();
  } catch {
    return fail(400, "invalid_amount", "Invalid paymentRequirements.amount");
  }
  if (value < requiredAmount) {
    return fail(
      400,
      "invalid_amount",
      `Authorization value ${value} is less than required ${requiredAmount}`,
    );
  }

  const nonce = auth.nonce as Hex;
  const validAfter = BigInt(auth.validAfter ?? "0");
  const validBefore = BigInt(auth.validBefore ?? "0");

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (validBefore !== 0n && validBefore <= nowSec) {
    return fail(
      400,
      "authorization_expired",
      "Authorization has expired (validBefore)",
    );
  }
  if (validAfter > nowSec) {
    return fail(
      400,
      "authorization_not_yet_valid",
      "Authorization is not yet valid (validAfter)",
    );
  }

  let sigValid: boolean;
  try {
    sigValid = await verifyTypedData({
      address: fromAddr,
      domain: buildEip712Domain(chain),
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
    return fail(400, "invalid_signature", `Invalid signature: ${message}`);
  }
  if (!sigValid) {
    return fail(
      400,
      "invalid_signature",
      "Signature does not match 'from' address",
    );
  }

  try {
    const used = await publicClient.readContract({
      address: chain.jpycAddress,
      abi: AUTH_STATE_ABI,
      functionName: "authorizationState",
      args: [fromAddr, nonce],
    });
    if (used) {
      return fail(
        400,
        "nonce_already_used",
        "Authorization nonce already used (replay)",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      "[payment-validation] authorizationState check failed:",
      message,
    );
    return fail(
      503,
      "rpc_unavailable",
      "Failed to check authorization state",
    );
  }

  return {
    ok: true,
    payment: {
      fromAddr,
      toAddr,
      value,
      validAfter,
      validBefore,
      nonce,
      signature: signature as Hex,
    },
  };
}

class SimulationTimeoutError extends Error {
  constructor() {
    super("simulation_timeout");
    this.name = "SimulationTimeoutError";
  }
}

const DEFAULT_SIMULATION_TIMEOUT_MS = 3000;

/**
 * Pre-flight on-chain validation for transferWithAuthorization.
 *
 * Catches reverts that signature/nonce/expiry checks cannot detect:
 * insufficient JPYC balance, frozen accounts, or facilitator gas
 * exhaustion. Required because verify=200 followed by settle=revert
 * is a worse failure mode than verify=400 up front.
 *
 * RPC timeouts return 503 (retriable) rather than 400 — a flaky
 * RPC must not be reported as a malformed authorization.
 */
export async function simulateTransferWithAuthorization(
  payment: ValidatedPayment,
  publicClient: PublicClient,
  facilitatorAddress: Address,
  options?: { timeoutMs?: number; chain?: ChainConfig },
): Promise<SimulationResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SIMULATION_TIMEOUT_MS;
  const chain = options?.chain ?? POLYGON;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new SimulationTimeoutError()),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([
      runSimulation(payment, publicClient, facilitatorAddress, chain),
      timeoutPromise,
    ]);
  } catch (err) {
    if (err instanceof SimulationTimeoutError) {
      return simFail(
        503,
        "simulation_timeout",
        `Simulation timed out after ${timeoutMs}ms`,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return simFail(503, "rpc_unavailable", `RPC unavailable: ${message}`);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

async function runSimulation(
  payment: ValidatedPayment,
  publicClient: PublicClient,
  facilitatorAddress: Address,
  chain: ChainConfig,
): Promise<SimulationResult> {
  const { fromAddr, toAddr, value, validAfter, validBefore, nonce, signature } =
    payment;

  let used: boolean;
  try {
    used = (await publicClient.readContract({
      address: chain.jpycAddress,
      abi: AUTH_STATE_ABI,
      functionName: "authorizationState",
      args: [fromAddr, nonce],
    })) as boolean;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return simFail(
      503,
      "rpc_unavailable",
      `Failed to read authorizationState: ${message}`,
    );
  }
  if (used) {
    return simFail(
      400,
      "nonce_already_used",
      "Authorization nonce already used (replay)",
    );
  }

  let v: number;
  let r: Hex;
  let s: Hex;
  try {
    ({ v, r, s } = splitEip3009Signature(signature));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return simFail(400, "invalid_signature", `Invalid signature: ${message}`);
  }

  const args = [
    fromAddr,
    toAddr,
    value,
    validAfter,
    validBefore,
    nonce,
    v,
    r,
    s,
  ] as const;

  try {
    await publicClient.simulateContract({
      address: chain.jpycAddress,
      abi: TRANSFER_WITH_AUTHORIZATION_ABI,
      functionName: "transferWithAuthorization",
      args,
      account: facilitatorAddress,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return simFail(400, "simulation_failed", `Simulation reverted: ${message}`);
  }

  let gasEstimate: bigint;
  try {
    gasEstimate = await publicClient.estimateContractGas({
      address: chain.jpycAddress,
      abi: TRANSFER_WITH_AUTHORIZATION_ABI,
      functionName: "transferWithAuthorization",
      args,
      account: facilitatorAddress,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return simFail(
      400,
      "simulation_failed",
      `Gas estimation failed: ${message}`,
    );
  }

  let balance: bigint;
  let gasPrice: bigint;
  try {
    [balance, gasPrice] = await Promise.all([
      publicClient.getBalance({ address: facilitatorAddress }),
      publicClient.getGasPrice(),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return simFail(
      503,
      "rpc_unavailable",
      `Failed to read balance or gasPrice: ${message}`,
    );
  }

  const estimatedCost = gasEstimate * gasPrice;
  if (balance < estimatedCost) {
    return simFail(
      503,
      "facilitator_insufficient_native_balance",
      `Facilitator native balance ${balance} wei < estimated cost ${estimatedCost} wei (gas=${gasEstimate}, price=${gasPrice})`,
    );
  }

  return { ok: true, gasEstimate };
}
