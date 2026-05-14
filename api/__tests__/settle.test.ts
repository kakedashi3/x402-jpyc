import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockSingle = vi.hoisted(() => vi.fn());
const mockRecipients = vi.hoisted(() =>
  vi.fn<() => Promise<{ data: Array<{ recipient_address: string }> | null }>>(),
);
const mockClaimNonce = vi.hoisted(() => vi.fn());
const mockVerifyTypedData = vi.hoisted(() => vi.fn());

vi.mock("../../lib/supabase.js", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "api_key_recipients") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => mockRecipients(),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: mockSingle,
            }),
          }),
        }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
  },
}));

vi.mock("../../lib/replay.js", () => ({
  claimNonce: mockClaimNonce,
}));

// Mock viem modules before importing handler
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(() => mockPublicClient),
    createWalletClient: vi.fn(() => mockWalletClient),
    verifyTypedData: mockVerifyTypedData,
  };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: "0xFacilitator0000000000000000000000000000",
    signTransaction: vi.fn(),
  })),
}));

const mockPublicClient = {
  readContract: vi.fn(),
};

const mockWalletClient = {
  writeContract: vi.fn(),
};

// Stub env before importing handler
vi.stubEnv("FACILITATOR_PRIVATE_KEY", "0x" + "ab".repeat(32));
vi.stubEnv("POLYGON_RPC_URL", "https://fake-rpc.test");
vi.stubEnv("AMOY_RPC_URL", "https://fake-amoy-rpc.test");
vi.stubEnv("API_KEY", "test-secret");

let handler: typeof import("../settle.js").default;

beforeAll(async () => {
  const mod = await import("../settle.js");
  handler = mod.default;
});

const JPYC_ADDRESS = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";

const validAuth = {
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  value: "1000000000000000000",
  validAfter: "0",
  validBefore: String(Math.floor(Date.now() / 1000) + 3600),
  nonce: "0x" + "aa".repeat(32),
};

// Last byte 0x1c (v=28) so viem.parseSignature accepts it.
const validSignature = "0x" + "bb".repeat(64) + "1c";

const validBody = {
  paymentPayload: {
    x402Version: 2,
    scheme: "exact",
    network: "eip155:137",
    payload: {
      signature: validSignature,
      authorization: validAuth,
    },
  },
  paymentRequirements: {
    scheme: "exact",
    network: "eip155:137",
    asset: JPYC_ADDRESS,
    amount: "1000000000000000000",
    payTo: "0x2222222222222222222222222222222222222222",
    extra: { name: "JPY Coin", version: "1" },
  },
};

function makeRequest(options: {
  method?: string;
  apiKey?: string;
  body?: unknown;
}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.apiKey) {
    headers.set("x-api-key", options.apiKey);
  }
  return new Request("https://example.com/api/settle", {
    method: options.method ?? "POST",
    headers,
    ...(options.method !== "GET" && {
      body:
        options.body !== undefined
          ? JSON.stringify(options.body)
          : "invalid json{",
    }),
  });
}

describe("POST /api/settle (EIP-3009)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("API_KEY", "test-secret");
    mockSingle.mockResolvedValue({
      data: {
        id: "key-id",
        user_id: "user-id",
        recipient_address: "0x2222222222222222222222222222222222222222",
        chain_id: 137,
      },
      error: null,
    });
    // Default: no recipients table rows → handler falls back to
    // api_keys.recipient_address as a single-element allowlist.
    mockRecipients.mockResolvedValue({ data: null });
    mockClaimNonce.mockResolvedValue({ ok: true, mode: "normal" });
    mockVerifyTypedData.mockResolvedValue(true);
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await handler(
      new Request("https://example.com/api/settle", { method: "GET" }),
    );
    expect(res.status).toBe(405);
  });

  it("returns 401 when X-API-Key header is missing", async () => {
    const res = await handler(makeRequest({ method: "POST", body: {} }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-API-Key header is wrong", async () => {
    mockSingle.mockResolvedValue({ data: null, error: "Not found" });
    const res = await handler(
      makeRequest({ method: "POST", apiKey: "wrong-key", body: {} }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("https://example.com/api/settle", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "test-secret",
      },
      body: "not valid json{{{",
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("Invalid JSON");
  });

  it("returns 400 when authorization is missing", async () => {
    const res = await handler(
      makeRequest({
        apiKey: "test-secret",
        body: {
          paymentPayload: { payload: {} },
          paymentRequirements: {},
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when nonce is already used", async () => {
    mockPublicClient.readContract.mockResolvedValue(true); // nonce used
    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: validBody }),
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("nonce already used");
  });

  it("returns 400 when authorization has expired", async () => {
    const expiredBody = structuredClone(validBody);
    expiredBody.paymentPayload.payload.authorization.validBefore = "1000"; // way in the past
    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: expiredBody }),
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("expired");
  });

  it("returns 400 when to does not match payTo", async () => {
    const mismatchBody = structuredClone(validBody);
    mismatchBody.paymentPayload.payload.authorization.to =
      "0x3333333333333333333333333333333333333333";
    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: mismatchBody }),
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("payTo");
  });

  it("returns 200 with success, txHash, transaction, payer and network on success", async () => {
    mockPublicClient.readContract.mockResolvedValue(false); // nonce not used
    mockWalletClient.writeContract.mockResolvedValue(
      "0xdeadbeef" as `0x${string}`,
    );

    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: validBody }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Replay-Protection")).toBe("normal");
    const data: any = await res.json();
    expect(data.success).toBe(true);
    // v2 canonical field name
    expect(data.transaction).toBe("0xdeadbeef");
    // legacy alias preserved for backward compatibility
    expect(data.txHash).toBe("0xdeadbeef");
    expect(data.payer).toBe("0x1111111111111111111111111111111111111111");
    expect(data.network).toBe("eip155:137");
  });

  it("accepts top-level x402Version when consistent with paymentPayload", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);
    mockWalletClient.writeContract.mockResolvedValue(
      "0xdeadbeef" as `0x${string}`,
    );

    const bodyWithTopVersion = { ...validBody, x402Version: 2 };
    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: bodyWithTopVersion }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects mismatched top-level x402Version", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);

    const bodyWithMismatch = { ...validBody, x402Version: 1 };
    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: bodyWithMismatch }),
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.code).toBe("invalid_x402_version");
    expect(data.errorReason).toBe("invalid_x402_version");
  });

  it("returns 503 when claimNonce returns fail_closed (Redis outage)", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);
    mockClaimNonce.mockResolvedValue({
      ok: false,
      mode: "fail_closed",
      error: "Redis unreachable",
    });

    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: validBody }),
    );
    expect(res.status).toBe(503);
    const data: any = await res.json();
    expect(data.code).toBe("service_unavailable");
  });

  it("includes X-Replay-Protection: degraded when fail-open is used", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);
    mockClaimNonce.mockResolvedValue({
      ok: true,
      mode: "fail_open",
      error: "Redis unreachable",
    });
    mockWalletClient.writeContract.mockResolvedValue(
      "0xdeadbeef" as `0x${string}`,
    );

    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: validBody }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Replay-Protection")).toBe("degraded");
  });

  it("returns 500 with errorReason, payer, transaction, network when transferWithAuthorization fails", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);
    mockWalletClient.writeContract.mockRejectedValue(
      new Error("execution reverted: ECRecover failed"),
    );

    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: validBody }),
    );
    expect(res.status).toBe(500);
    const data: any = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("Transaction execution failed");
    expect(data.errorReason).toBe("transaction_failed");
    expect(data.payer).toBe("0x1111111111111111111111111111111111111111");
    expect(data.transaction).toBe("");
    expect(data.network).toBe("eip155:137");
  });

  describe("allowlist (api_key_recipients)", () => {
    const RECIPIENT_A = "0xAAaaAAAAAAaaaaaaaAaaaAaaAaAaAAaAAAaaAaAa";
    const RECIPIENT_B = "0xBbbbbbbBBBbbBbBBbbbbbbBbBbbbbBBbbBBBbBBB";
    const PRIMARY = "0x9999999999999999999999999999999999999999";

    beforeEach(() => {
      mockSingle.mockResolvedValue({
        data: {
          id: "key-id",
          user_id: "user-id",
          recipient_address: PRIMARY,
          chain_id: 137,
        },
        error: null,
      });
      mockPublicClient.readContract.mockResolvedValue(false); // nonce unused
      mockWalletClient.writeContract.mockResolvedValue(
        "0xdeadbeef" as `0x${string}`,
      );
    });

    it("settles to the matched recipient, not the api_keys primary", async () => {
      mockRecipients.mockResolvedValue({
        data: [
          { recipient_address: RECIPIENT_A },
          { recipient_address: RECIPIENT_B },
        ],
      });

      const body = structuredClone(validBody);
      body.paymentPayload.payload.authorization.to = RECIPIENT_A;
      body.paymentRequirements.payTo = RECIPIENT_A;

      const res = await handler(makeRequest({ apiKey: "test-secret", body }));
      expect(res.status).toBe(200);

      // The on-chain `to` arg must be the matched recipient (A), not the
      // api_keys primary. This is the whole point of the allowlist: each
      // settlement goes to the specific seller the buyer paid, not a
      // single house wallet.
      const writeArgs = mockWalletClient.writeContract.mock.calls[0]?.[0];
      expect(writeArgs).toBeDefined();
      // args order: [from, to, value, validAfter, validBefore, nonce, v, r, s]
      const toArg = writeArgs.args[1] as string;
      expect(toArg.toLowerCase()).toBe(RECIPIENT_A.toLowerCase());
      expect(toArg.toLowerCase()).not.toBe(PRIMARY.toLowerCase());
    });

    it("settles to recipient B when the buyer paid recipient B", async () => {
      mockRecipients.mockResolvedValue({
        data: [
          { recipient_address: RECIPIENT_A },
          { recipient_address: RECIPIENT_B },
        ],
      });

      const body = structuredClone(validBody);
      body.paymentPayload.payload.authorization.to = RECIPIENT_B;
      body.paymentRequirements.payTo = RECIPIENT_B;

      const res = await handler(makeRequest({ apiKey: "test-secret", body }));
      expect(res.status).toBe(200);

      const writeArgs = mockWalletClient.writeContract.mock.calls[0]?.[0];
      const toArg = writeArgs.args[1] as string;
      expect(toArg.toLowerCase()).toBe(RECIPIENT_B.toLowerCase());
    });

    it("rejects settle when authorization.to is not in the allowlist", async () => {
      mockRecipients.mockResolvedValue({
        data: [{ recipient_address: RECIPIENT_A }],
      });

      const body = structuredClone(validBody);
      body.paymentPayload.payload.authorization.to = RECIPIENT_B;
      body.paymentRequirements.payTo = RECIPIENT_B;

      const res = await handler(makeRequest({ apiKey: "test-secret", body }));
      expect(res.status).toBe(400);
      const data: any = await res.json();
      expect(data.errorReason).toBe("invalid_pay_to");
      expect(data.error).toContain("allowlist");
      // Must not have called writeContract on a rejected settle.
      expect(mockWalletClient.writeContract).not.toHaveBeenCalled();
    });

    it("rejects settle to the primary when allowlist is populated and excludes it", async () => {
      mockRecipients.mockResolvedValue({
        data: [{ recipient_address: RECIPIENT_A }],
      });

      // validBody pays to 0x2222... which is neither A nor PRIMARY.
      const res = await handler(
        makeRequest({ apiKey: "test-secret", body: validBody }),
      );
      expect(res.status).toBe(400);
      const data: any = await res.json();
      expect(data.errorReason).toBe("invalid_pay_to");
      expect(mockWalletClient.writeContract).not.toHaveBeenCalled();
    });
  });
});
