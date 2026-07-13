import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockVerifyTypedData = vi.hoisted(() => vi.fn());
const mockClaimNonce = vi.hoisted(() => vi.fn());

// No api_keys table to mock any more — the facilitator is open. We fake the
// Redis store instead, so the rate limiter and the daily sponsored-gas budget
// that REPLACED the API key are exercised for real.
const fakeRedis = vi.hoisted(() => {
  const store = new Map<string, number | string>();
  return {
    store,
    incr: async (k: string) => {
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, n);
      return n;
    },
    decr: async (k: string) => {
      const n = Number(store.get(k) ?? 0) - 1;
      store.set(k, n);
      return n;
    },
    expire: async () => 1,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string, o?: { nx?: boolean }) => {
      if (o?.nx && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    },
  };
});

vi.mock("../../lib/redis.js", () => ({
  getRedis: () => fakeRedis,
  resetRedisForTests: () => {},
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
vi.stubEnv("ETHEREUM_RPC_URL", "https://fake-eth-rpc.test");
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
  body?: unknown;
}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
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
    // The fake Redis is module-scoped, so rate-limit counters and gas budgets
    // would otherwise leak from one test into the next.
    fakeRedis.store.clear();
    vi.stubEnv("API_KEY", "test-secret");
    mockClaimNonce.mockResolvedValue({ ok: true, mode: "normal" });
    mockVerifyTypedData.mockResolvedValue(true);
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await handler(
      new Request("https://example.com/api/settle", { method: "GET" }),
    );
    expect(res.status).toBe(405);
  });

  // The facilitator is open. A caller with no credentials whatsoever must get a
  // real answer about their payment, not a 401 — that is the entire point of
  // the redesign, and every other facilitator in the x402 directory behaves
  // this way (PayAI, Dexter, Mogami, HPP all require no API key).
  it("does not require an API key — an unauthenticated settle is processed", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);
    mockWalletClient.writeContract.mockResolvedValue(
      "0xdeadbeef" as `0x${string}`,
    );
    const res = await handler(makeRequest({ method: "POST", body: validBody }));
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.success).toBe(true);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("https://example.com/api/settle", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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
      makeRequest({ body: {
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
      makeRequest({ body: validBody }),
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("nonce already used");
  });

  it("returns 400 when authorization has expired", async () => {
    const expiredBody = structuredClone(validBody);
    expiredBody.paymentPayload.payload.authorization.validBefore = "1000"; // way in the past
    const res = await handler(
      makeRequest({ body: expiredBody }),
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
      makeRequest({ body: mismatchBody }),
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
      makeRequest({ body: validBody }),
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
      makeRequest({ body: bodyWithTopVersion }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects mismatched top-level x402Version", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);

    const bodyWithMismatch = { ...validBody, x402Version: 1 };
    const res = await handler(
      makeRequest({ body: bodyWithMismatch }),
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
      makeRequest({ body: validBody }),
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
      makeRequest({ body: validBody }),
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
      makeRequest({ body: validBody }),
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

  // The allowlist is gone. These are the controls that replaced it.
  describe("open facilitator — what replaced the API key", () => {
    const STRANGER = "0xAAaaAAAAAAaaaaaaaAaaaAaaAaAaAAaAAAaaAaAa";
    const OTHER = "0xBbbbbbbBBBbbBbBBbbbbbbBbBbbbbBBbbBBBbBBB";

    beforeEach(() => {
      mockPublicClient.readContract.mockResolvedValue(false); // nonce unused
      mockWalletClient.writeContract.mockResolvedValue(
        "0xdeadbeef" as `0x${string}`,
      );
    });

    it("settles for a payTo nobody registered — any seller can use it now", async () => {
      const body = structuredClone(validBody);
      body.paymentPayload.payload.authorization.to = STRANGER;
      body.paymentRequirements.payTo = STRANGER;

      const res = await handler(makeRequest({ body }));
      expect(res.status).toBe(200);

      // Funds go to the address the buyer signed, which is the only address
      // the facilitator is even able to send to.
      const writeArgs = mockWalletClient.writeContract.mock.calls[0]?.[0];
      const toArg = writeArgs.args[1] as string;
      expect(toArg.toLowerCase()).toBe(STRANGER.toLowerCase());
    });

    it("rejects when the signed `to` disagrees with the declared payTo", async () => {
      const body = structuredClone(validBody);
      body.paymentPayload.payload.authorization.to = STRANGER;
      body.paymentRequirements.payTo = OTHER;

      const res = await handler(makeRequest({ body }));
      expect(res.status).toBe(400);
      const data: any = await res.json();
      expect(data.errorReason).toBe("invalid_pay_to");
      expect(mockWalletClient.writeContract).not.toHaveBeenCalled();
    });

    it("refuses to broadcast once the chain's sponsored-gas budget is spent", async () => {
      const today = `gasbudget:137:${new Date().toISOString().slice(0, 10)}`;
      fakeRedis.store.set(today, 5000); // Polygon default

      const res = await handler(makeRequest({ body: validBody }));
      expect(res.status).toBe(429);
      const data: any = await res.json();
      expect(data.errorReason).toBe("budget_exhausted");
      // The bound has to actually bind: no gas may be spent past it.
      expect(mockWalletClient.writeContract).not.toHaveBeenCalled();
    });

    // The budget MUST be per chain. One settlement costs ~¥0.06 on Polygon and
    // ~¥252 on Ethereum, so a shared 5,000/day cap would be ¥300 of exposure on
    // Polygon and ¥1,260,000 on Ethereum — a stranger could drain the L1 wallet.
    it("budgets each chain separately — Ethereum's cap is not Polygon's", async () => {
      const day = new Date().toISOString().slice(0, 10);
      // Spend Ethereum's entire daily allowance (10), leave Polygon untouched.
      fakeRedis.store.set(`gasbudget:1:${day}`, 10);

      const ethBody = structuredClone(validBody);
      ethBody.paymentPayload.network = "eip155:1";
      ethBody.paymentRequirements.network = "eip155:1";

      const eth = await handler(makeRequest({ body: ethBody }));
      expect(eth.status).toBe(429);
      expect((await eth.json()).errorReason).toBe("budget_exhausted");
      expect(mockWalletClient.writeContract).not.toHaveBeenCalled();

      // Polygon still settles — exhausting L1 must not take the cheap chains
      // down with it.
      const poly = await handler(makeRequest({ body: validBody }));
      expect(poly.status).toBe(200);
    });

    it("rate-limits a caller hammering the endpoint from one IP", async () => {
      const hammer = () => {
        const req = new Request("https://example.com/api/settle", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-for": "203.0.113.9",
          },
          body: JSON.stringify(validBody),
        });
        return handler(req);
      };
      // RATE_LIMIT_RPS defaults to 4; the 5th call in the same second trips it.
      const codes: number[] = [];
      for (let i = 0; i < 6; i++) codes.push((await hammer()).status);
      expect(codes).toContain(429);
    });
  });
});
