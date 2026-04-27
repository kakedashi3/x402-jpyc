import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import {
  JPYC,
  isValidNonceFormat,
  simulateTransferWithAuthorization,
  splitEip3009Signature,
  validatePayment,
  type PaymentRequestBody,
  type ValidatedPayment,
} from "../payment-validation.js";
import {
  FACILITATOR_ADDRESS,
  RECIPIENT_ADDRESS,
  signAuthorization,
  testSigner,
  wrongSigner,
} from "./fixtures/signer.js";
import {
  asPublicClient,
  createMockPublicClient,
} from "./fixtures/mock-client.js";

const NONCE_A = ("0x" + "aa".repeat(32)) as Hex;
const ASSET = JPYC.ADDRESS;

function nowSec(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

interface BodyOverrides {
  value?: string;
  amount?: string;
  validAfter?: string;
  validBefore?: string;
  nonce?: Hex;
  to?: string;
  payTo?: string;
  network?: string;
  payloadNetwork?: string;
  scheme?: string;
  payloadScheme?: string;
  x402Version?: number | undefined;
  asset?: string;
  extraName?: string;
  extraVersion?: string;
  signWith?: typeof testSigner;
  signatureOverride?: Hex;
}

async function buildValidBody(
  overrides: BodyOverrides = {},
): Promise<PaymentRequestBody> {
  const validBefore = overrides.validBefore ?? String(Number(nowSec()) + 3600);
  const validAfter = overrides.validAfter ?? "0";
  const value = overrides.value ?? "1000000000000000000";
  const amount = overrides.amount ?? value;
  const nonce = overrides.nonce ?? NONCE_A;
  const to = (overrides.to ?? RECIPIENT_ADDRESS) as `0x${string}`;
  const payTo = (overrides.payTo ?? RECIPIENT_ADDRESS) as `0x${string}`;
  const signer = overrides.signWith ?? testSigner;

  const signature =
    overrides.signatureOverride ??
    (await signAuthorization(signer, {
      from: signer.address,
      to,
      value: BigInt(value),
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    }));

  return {
    paymentPayload: {
      x402Version: overrides.x402Version ?? 2,
      scheme: overrides.payloadScheme ?? "exact",
      network: overrides.payloadNetwork ?? "eip155:137",
      payload: {
        signature,
        authorization: {
          from: signer.address,
          to,
          value,
          validAfter,
          validBefore,
          nonce,
        },
      },
    },
    paymentRequirements: {
      scheme: overrides.scheme ?? "exact",
      network: overrides.network ?? "eip155:137",
      asset: overrides.asset ?? ASSET,
      amount,
      payTo,
      extra: {
        name: overrides.extraName ?? "JPY Coin",
        version: overrides.extraVersion ?? "1",
      },
    },
  };
}

function makePayment(overrides: Partial<ValidatedPayment> = {}): ValidatedPayment {
  return {
    fromAddr: testSigner.address,
    toAddr: RECIPIENT_ADDRESS,
    value: 1_000_000_000_000_000_000n,
    validAfter: 0n,
    validBefore: nowSec() + 3600n,
    nonce: NONCE_A,
    signature: ("0x" + "bb".repeat(65)) as Hex,
    ...overrides,
  };
}

describe("isValidNonceFormat", () => {
  it("accepts a 0x-prefixed 32-byte hex string", () => {
    expect(isValidNonceFormat("0x" + "aa".repeat(32))).toBe(true);
    expect(isValidNonceFormat("0x" + "00".repeat(32))).toBe(true);
  });

  it("rejects wrong length, missing prefix, or non-hex", () => {
    expect(isValidNonceFormat("0xaa")).toBe(false);
    expect(isValidNonceFormat("aa".repeat(32))).toBe(false);
    expect(isValidNonceFormat("0x" + "zz".repeat(32))).toBe(false);
    expect(isValidNonceFormat(123 as unknown)).toBe(false);
    expect(isValidNonceFormat(undefined as unknown)).toBe(false);
  });
});

describe("splitEip3009Signature", () => {
  it("splits a 65-byte signature into v/r/s and normalizes v<27", () => {
    const r = "11".repeat(32);
    const s = "22".repeat(32);
    const sig = ("0x" + r + s + "00") as Hex;
    const out = splitEip3009Signature(sig);
    expect(out.r).toBe(("0x" + r) as Hex);
    expect(out.s).toBe(("0x" + s) as Hex);
    expect(out.v).toBe(27);
  });

  it("preserves v when already 27 or 28", () => {
    const sig = ("0x" + "11".repeat(32) + "22".repeat(32) + "1c") as Hex;
    expect(splitEip3009Signature(sig).v).toBe(28);
  });

  it("throws on wrong length", () => {
    expect(() => splitEip3009Signature("0xdeadbeef" as Hex)).toThrow(
      /signature length/,
    );
  });
});

describe("validatePayment — success cases", () => {
  let client: ReturnType<typeof createMockPublicClient>;

  beforeEach(() => {
    client = createMockPublicClient();
  });

  it("ok: exact amount, valid signature, registered payTo", async () => {
    const body = await buildValidBody();
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(true);
  });

  it("ok: overpayment (value > maxAmountRequired)", async () => {
    const body = await buildValidBody({
      value: "2000000000000000000",
      amount: "1000000000000000000",
    });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(true);
  });

  it("ok: validAfter < now < validBefore boundary", async () => {
    const now = Number(nowSec());
    const body = await buildValidBody({
      validAfter: String(now - 10),
      validBefore: String(now + 10),
    });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(true);
  });

  it("ok: x402Version 1 also accepted", async () => {
    const body = await buildValidBody({ x402Version: 1 });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(true);
  });
});

describe("validatePayment — error cases", () => {
  let client: ReturnType<typeof createMockPublicClient>;

  beforeEach(() => {
    client = createMockPublicClient();
  });

  it("invalid_signature: signed by a different key", async () => {
    const body = await buildValidBody();
    // tamper: use the wrong signer's signature for the testSigner's authorization
    const signature = await signAuthorization(wrongSigner, {
      from: testSigner.address,
      to: RECIPIENT_ADDRESS,
      value: 1_000_000_000_000_000_000n,
      validAfter: 0n,
      validBefore: BigInt(body.paymentPayload!.payload!.authorization!.validBefore!),
      nonce: NONCE_A,
    });
    body.paymentPayload!.payload!.signature = signature;

    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_signature");
      expect(result.status).toBe(400);
    }
  });

  it("invalid_pay_to: payTo does not match the API key bind", async () => {
    const body = await buildValidBody({
      to: "0x4444444444444444444444444444444444444444",
      payTo: "0x4444444444444444444444444444444444444444",
    });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_pay_to");
  });

  it("invalid_amount: value < amount", async () => {
    const body = await buildValidBody({
      value: "500",
      amount: "1000",
    });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_amount");
  });

  it("authorization_expired: validBefore <= now", async () => {
    const body = await buildValidBody({
      validBefore: String(Number(nowSec()) - 1),
    });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("authorization_expired");
  });

  it("authorization_not_yet_valid: validAfter > now", async () => {
    const body = await buildValidBody({
      validAfter: String(Number(nowSec()) + 3600),
      validBefore: String(Number(nowSec()) + 7200),
    });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("authorization_not_yet_valid");
  });

  it("invalid_chain_id: network is not eip155:137", async () => {
    const body = await buildValidBody({
      network: "eip155:1",
      payloadNetwork: "eip155:1",
    });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_chain_id");
  });

  it("nonce_already_used: authorizationState returns true", async () => {
    client.readContract.mockResolvedValueOnce(true);
    const body = await buildValidBody();
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("nonce_already_used");
  });

  it("invalid_amount: amount of 0 is rejected", async () => {
    const body = await buildValidBody({
      value: "0",
      amount: "0",
    });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_amount");
  });

  it("invalid_nonce_format: nonce not 32 bytes", async () => {
    const body = await buildValidBody();
    body.paymentPayload!.payload!.authorization!.nonce = "0x00";
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_nonce_format");
  });

  it("invalid_amount: value provided as number instead of string", async () => {
    const body = await buildValidBody();
    // Force non-string at runtime — TS would normally reject this.
    (body.paymentPayload!.payload!.authorization as { value: unknown }).value =
      1000;
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_amount");
  });

  it("rpc_unavailable: authorizationState read throws", async () => {
    client.readContract.mockRejectedValueOnce(new Error("RPC down"));
    const body = await buildValidBody();
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_unavailable");
      expect(result.status).toBe(503);
    }
  });

  it("invalid_request: missing payload entirely", async () => {
    const result = await validatePayment(
      { paymentPayload: { payload: {} } } as PaymentRequestBody,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_request");
  });

  it("invalid_x402_version: 99", async () => {
    const body = await buildValidBody({ x402Version: 99 });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_x402_version");
  });

  it("invalid_scheme: payloadScheme not exact", async () => {
    const body = await buildValidBody({ payloadScheme: "approve" });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_scheme");
  });

  it("invalid_extra: name mismatch", async () => {
    const body = await buildValidBody({ extraName: "Wrong Name" });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_extra");
  });

  it("invalid_asset: not the JPYC contract", async () => {
    const body = await buildValidBody({
      asset: "0x0000000000000000000000000000000000000001",
    });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_asset");
  });

  it("invalid_scheme: paymentRequirements.scheme not exact", async () => {
    const body = await buildValidBody({ scheme: "approve" });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_scheme");
  });

  it("invalid_chain_id: paymentRequirements.network mismatch only", async () => {
    const body = await buildValidBody({ network: "eip155:1" });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_chain_id");
  });

  it("invalid_extra: version mismatch", async () => {
    const body = await buildValidBody({ extraVersion: "2" });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_extra");
  });

  it("invalid_request: signature missing", async () => {
    const body = await buildValidBody();
    delete body.paymentPayload!.payload!.signature;
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_request");
  });

  it("invalid_address: malformed from address", async () => {
    const body = await buildValidBody();
    body.paymentPayload!.payload!.authorization!.from = "0xnotanaddress";
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_address");
  });

  it("invalid_asset: asset address malformed", async () => {
    const body = await buildValidBody({ asset: "0xnotanaddress" });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_asset");
  });

  it("invalid_asset: asset missing", async () => {
    const body = await buildValidBody();
    body.paymentRequirements!.asset = undefined;
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_asset");
  });

  it("invalid_pay_to: payTo missing", async () => {
    const body = await buildValidBody();
    body.paymentRequirements!.payTo = undefined;
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_pay_to");
  });

  it("invalid_pay_to: payTo malformed", async () => {
    const body = await buildValidBody({ payTo: "0xnotanaddress" });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_pay_to");
  });

  it("invalid_amount: amount missing", async () => {
    const body = await buildValidBody();
    body.paymentRequirements!.amount = undefined;
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_amount");
  });

  it("invalid_amount: required amount of 0", async () => {
    const body = await buildValidBody({ value: "1", amount: "0" });
    const result = await validatePayment(
      body,
      RECIPIENT_ADDRESS,
      asPublicClient(client),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_amount");
  });
});

describe("simulateTransferWithAuthorization", () => {
  let client: ReturnType<typeof createMockPublicClient>;

  beforeEach(() => {
    client = createMockPublicClient();
  });

  it("ok: returns gasEstimate when balance covers cost", async () => {
    const result = await simulateTransferWithAuthorization(
      makePayment(),
      asPublicClient(client),
      FACILITATOR_ADDRESS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.gasEstimate).toBe(80_000n);
  });

  it("nonce_already_used: authorizationState returns true", async () => {
    client.readContract.mockResolvedValueOnce(true);
    const result = await simulateTransferWithAuthorization(
      makePayment(),
      asPublicClient(client),
      FACILITATOR_ADDRESS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("nonce_already_used");
      expect(result.status).toBe(400);
    }
  });

  it("simulation_failed: simulateContract reverts", async () => {
    client.simulateContract.mockRejectedValueOnce(
      new Error("execution reverted: ERC20: insufficient balance"),
    );
    const result = await simulateTransferWithAuthorization(
      makePayment(),
      asPublicClient(client),
      FACILITATOR_ADDRESS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("simulation_failed");
      expect(result.status).toBe(400);
    }
  });

  it("simulation_failed: estimateContractGas reverts", async () => {
    client.estimateContractGas.mockRejectedValueOnce(
      new Error("execution reverted"),
    );
    const result = await simulateTransferWithAuthorization(
      makePayment(),
      asPublicClient(client),
      FACILITATOR_ADDRESS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("simulation_failed");
  });

  it("facilitator_insufficient_native_balance: balance < gas*price", async () => {
    client.estimateContractGas.mockResolvedValueOnce(100_000n);
    client.getGasPrice.mockResolvedValueOnce(100n * 10n ** 9n);
    client.getBalance.mockResolvedValueOnce(1n);
    const result = await simulateTransferWithAuthorization(
      makePayment(),
      asPublicClient(client),
      FACILITATOR_ADDRESS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("facilitator_insufficient_native_balance");
      expect(result.status).toBe(503);
    }
  });

  it("rpc_unavailable: getBalance throws", async () => {
    client.getBalance.mockRejectedValueOnce(new Error("network unreachable"));
    const result = await simulateTransferWithAuthorization(
      makePayment(),
      asPublicClient(client),
      FACILITATOR_ADDRESS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_unavailable");
      expect(result.status).toBe(503);
    }
  });

  it("simulation_timeout: returns 503 when an RPC call exceeds the timeout", async () => {
    vi.useFakeTimers();
    try {
      client.readContract.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(false), 10_000);
          }),
      );
      const promise = simulateTransferWithAuthorization(
        makePayment(),
        asPublicClient(client),
        FACILITATOR_ADDRESS,
        { timeoutMs: 50 },
      );
      await vi.advanceTimersByTimeAsync(60);
      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("simulation_timeout");
        expect(result.status).toBe(503);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalid_signature: payment.signature has wrong length", async () => {
    const result = await simulateTransferWithAuthorization(
      makePayment({ signature: "0xdeadbeef" as Hex }),
      asPublicClient(client),
      FACILITATOR_ADDRESS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_signature");
  });

  it("rpc_unavailable: authorizationState read inside simulate throws", async () => {
    client.readContract.mockRejectedValueOnce(new Error("boom"));
    const result = await simulateTransferWithAuthorization(
      makePayment(),
      asPublicClient(client),
      FACILITATOR_ADDRESS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("rpc_unavailable");
      expect(result.status).toBe(503);
    }
  });
});
