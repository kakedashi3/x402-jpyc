import {
  getAddress,
  parseAbi,
  verifyTypedData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

export const JPYC = {
  ADDRESS: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29" as Address,
  CHAIN_ID: 137,
  NETWORK: "eip155:137",
  SCHEME: "exact",
  EIP712_NAME: "JPY Coin",
  EIP712_VERSION: "1",
} as const;

const SUPPORTED_X402_VERSIONS = new Set([1, 2]);

const AUTH_STATE_ABI = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

const EIP712_DOMAIN = {
  name: JPYC.EIP712_NAME,
  version: JPYC.EIP712_VERSION,
  chainId: JPYC.CHAIN_ID,
  verifyingContract: JPYC.ADDRESS,
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
  | { ok: false; status: number; error: string };

function fail(status: number, error: string): ValidationResult {
  return { ok: false, status, error };
}

export async function validatePayment(
  body: PaymentRequestBody,
  recipientAddress: Address,
  publicClient: PublicClient,
): Promise<ValidationResult> {
  const { paymentPayload, paymentRequirements } = body;

  if (!paymentPayload?.payload?.authorization || !paymentRequirements) {
    return fail(
      400,
      "Missing required fields: paymentPayload.payload.authorization, paymentRequirements",
    );
  }

  const version = paymentPayload.x402Version;
  if (typeof version !== "number" || !SUPPORTED_X402_VERSIONS.has(version)) {
    return fail(400, `Unsupported x402Version: ${version} (expected 1 or 2)`);
  }

  if (paymentPayload.scheme !== JPYC.SCHEME) {
    return fail(
      400,
      `Unsupported paymentPayload.scheme: ${paymentPayload.scheme} (expected ${JPYC.SCHEME})`,
    );
  }
  if (paymentRequirements.scheme !== JPYC.SCHEME) {
    return fail(
      400,
      `Unsupported paymentRequirements.scheme: ${paymentRequirements.scheme} (expected ${JPYC.SCHEME})`,
    );
  }

  if (paymentPayload.network !== JPYC.NETWORK) {
    return fail(
      400,
      `Unsupported paymentPayload.network: ${paymentPayload.network} (expected ${JPYC.NETWORK})`,
    );
  }
  if (paymentRequirements.network !== JPYC.NETWORK) {
    return fail(
      400,
      `Unsupported paymentRequirements.network: ${paymentRequirements.network} (expected ${JPYC.NETWORK})`,
    );
  }

  const extra = paymentRequirements.extra;
  if (extra) {
    if (extra.name !== undefined && extra.name !== JPYC.EIP712_NAME) {
      return fail(
        400,
        `paymentRequirements.extra.name mismatch: "${extra.name}" (expected "${JPYC.EIP712_NAME}")`,
      );
    }
    if (extra.version !== undefined && extra.version !== JPYC.EIP712_VERSION) {
      return fail(
        400,
        `paymentRequirements.extra.version mismatch: "${extra.version}" (expected "${JPYC.EIP712_VERSION}")`,
      );
    }
  }

  const auth = paymentPayload.payload.authorization;
  const signature = paymentPayload.payload.signature;

  if (!auth.from || !auth.to || !auth.value || !auth.nonce || !signature) {
    return fail(
      400,
      "Missing fields: from, to, value, nonce, and payload.signature are required",
    );
  }

  let fromAddr: Address;
  let toAddr: Address;
  try {
    fromAddr = getAddress(auth.from);
    toAddr = getAddress(auth.to);
  } catch {
    return fail(400, "Invalid from or to address");
  }

  if (!paymentRequirements.asset) {
    return fail(400, "Missing paymentRequirements.asset");
  }
  try {
    if (getAddress(paymentRequirements.asset) !== getAddress(JPYC.ADDRESS)) {
      return fail(400, `Unsupported asset: expected JPYC (${JPYC.ADDRESS})`);
    }
  } catch {
    return fail(400, "Invalid asset address");
  }

  if (!paymentRequirements.payTo) {
    return fail(400, "Missing paymentRequirements.payTo");
  }
  let declaredPayTo: Address;
  try {
    declaredPayTo = getAddress(paymentRequirements.payTo);
  } catch {
    return fail(400, "Invalid paymentRequirements.payTo address");
  }
  if (declaredPayTo !== recipientAddress) {
    return fail(
      400,
      "paymentRequirements.payTo does not match registered payTo address",
    );
  }
  if (toAddr !== recipientAddress) {
    return fail(
      400,
      "Authorization 'to' does not match registered payTo address",
    );
  }

  let value: bigint;
  try {
    value = BigInt(auth.value);
    if (value <= 0n) throw new Error();
  } catch {
    return fail(400, "Invalid authorization value");
  }

  if (!paymentRequirements.amount) {
    return fail(400, "Missing paymentRequirements.amount");
  }
  let requiredAmount: bigint;
  try {
    requiredAmount = BigInt(paymentRequirements.amount);
    if (requiredAmount <= 0n) throw new Error();
  } catch {
    return fail(400, "Invalid paymentRequirements.amount");
  }
  if (value < requiredAmount) {
    return fail(
      400,
      `Authorization value ${value} is less than required ${requiredAmount}`,
    );
  }

  const nonce = auth.nonce as Hex;
  const validAfter = BigInt(auth.validAfter ?? "0");
  const validBefore = BigInt(auth.validBefore ?? "0");

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (validBefore !== 0n && validBefore < nowSec) {
    return fail(400, "Authorization has expired (validBefore)");
  }
  if (validAfter > nowSec) {
    return fail(400, "Authorization is not yet valid (validAfter)");
  }

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
    return fail(400, `Invalid signature: ${message}`);
  }
  if (!sigValid) {
    return fail(400, "Signature does not match 'from' address");
  }

  try {
    const used = await publicClient.readContract({
      address: JPYC.ADDRESS,
      abi: AUTH_STATE_ABI,
      functionName: "authorizationState",
      args: [fromAddr, nonce],
    });
    if (used) {
      return fail(400, "Authorization nonce already used (replay)");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[payment-validation] authorizationState check failed:", message);
    return fail(500, "Failed to check authorization state");
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
