import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockVerifyTypedData = vi.hoisted(() => vi.fn());

// The facilitator is open — there is no api_keys lookup to mock any more.
// What we DO mock is the Redis store, so the rate limiter that replaced the
// API key runs for real against an in-memory fake.
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

// Mock viem modules before importing handler
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...actual,
    createPublicClient: vi.fn(() => mockPublicClient),
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
  simulateContract: vi.fn(),
  estimateContractGas: vi.fn(),
  getBalance: vi.fn(),
  getGasPrice: vi.fn(),
};

// Stub env before importing handler
vi.stubEnv("POLYGON_RPC_URL", "https://fake-rpc.test");
vi.stubEnv("AMOY_RPC_URL", "https://fake-amoy-rpc.test");
vi.stubEnv("FACILITATOR_PRIVATE_KEY", "0x" + "ab".repeat(32));
vi.stubEnv("API_KEY", "test-secret");

let handler: typeof import("../verify.js").default;

beforeAll(async () => {
  const mod = await import("../verify.js");
  handler = mod.default;
});

const JPYC_ADDRESS = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";

const validAuth = {
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  value: "10000000000000000000",
  validAfter: "0",
  validBefore: String(Math.floor(Date.now() / 1000) + 3600),
  nonce: "0x" + "aa".repeat(32),
};

// Last byte 0x1c (v=28) so viem.parseSignature accepts it during simulate.
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
    amount: "10000000000000000000",
    payTo: "0x2222222222222222222222222222222222222222",
    extra: { name: "JPY Coin", version: "1" },
  },
};

function makeRequest(options: {
  method?: string;
  body?: unknown;
}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  return new Request("https://example.com/api/verify", {
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

describe("POST /api/verify (EIP-3009)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The fake Redis is module-scoped, so rate-limit counters and gas budgets
    // would otherwise leak from one test into the next.
    fakeRedis.store.clear();
    vi.stubEnv("API_KEY", "test-secret");
    mockVerifyTypedData.mockResolvedValue(true);
    mockPublicClient.simulateContract.mockResolvedValue({ result: undefined });
    mockPublicClient.estimateContractGas.mockResolvedValue(80_000n);
    mockPublicClient.getBalance.mockResolvedValue(10n ** 18n);
    mockPublicClient.getGasPrice.mockResolvedValue(50n * 10n ** 9n);
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await handler(
      new Request("https://example.com/api/verify", { method: "GET" }),
    );
    expect(res.status).toBe(405);
  });

  // Open facilitator: no credential, real answer. /verify spends no gas — it is
  // a read-only simulation — so there is nothing here an API key could protect.
  it("does not require an API key — an unauthenticated verify is processed", async () => {
    const res = await handler(makeRequest({ method: "POST", body: validBody }));
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.isValid).toBe(true);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("https://example.com/api/verify", {
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
      makeRequest({
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

  it("returns 200 with isValid and payer on success", async () => {
    mockPublicClient.readContract.mockResolvedValue(false); // nonce not used

    const res = await handler(
      makeRequest({ body: validBody }),
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.isValid).toBe(true);
    expect(data.payer).toBe("0x1111111111111111111111111111111111111111");
    expect(data.txHash).toBeUndefined();
  });

  it("includes invalidReason on validation failures (v2 canonical)", async () => {
    const expiredBody = structuredClone(validBody);
    expiredBody.paymentPayload.payload.authorization.validBefore = "1000";

    const res = await handler(
      makeRequest({ body: expiredBody }),
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.isValid).toBe(false);
    expect(data.invalidReason).toBe("authorization_expired");
    // legacy field preserved
    expect(data.code).toBe("authorization_expired");
  });

  it("returns 503 when authorizationState RPC call fails", async () => {
    mockPublicClient.readContract.mockRejectedValue(new Error("RPC error"));

    const res = await handler(
      makeRequest({ body: validBody }),
    );
    expect(res.status).toBe(503);
    const data: any = await res.json();
    expect(data.error).toContain("authorization state");
    expect(data.code).toBe("rpc_unavailable");
  });

  it("returns 503 when facilitator native balance is insufficient", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);
    mockPublicClient.estimateContractGas.mockResolvedValue(100_000n);
    mockPublicClient.getGasPrice.mockResolvedValue(100n * 10n ** 9n);
    mockPublicClient.getBalance.mockResolvedValue(1n); // ~zero

    const res = await handler(
      makeRequest({ body: validBody }),
    );
    expect(res.status).toBe(503);
    const data: any = await res.json();
    expect(data.code).toBe("facilitator_insufficient_native_balance");
  });

  it("returns 400 with simulation_failed code when simulate reverts", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);
    mockPublicClient.simulateContract.mockRejectedValue(
      new Error("execution reverted: ECRecover failed"),
    );

    const res = await handler(
      makeRequest({ body: validBody }),
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.code).toBe("simulation_failed");
  });

  it("returns 400 when signature does not match from", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);
    mockVerifyTypedData.mockResolvedValue(false);

    const res = await handler(
      makeRequest({ body: validBody }),
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("Signature");
    // v2 canonical: error responses now include isValid:false
    expect(data.isValid).toBe(false);
    expect(data.invalidReason).toBe("invalid_signature");
  });

  describe("open facilitator — what replaced the API key", () => {
    const STRANGER = "0xAAaaAAAAAAaaaaaaaAaaaAaaAaAaAAaAAAaaAaAa";
    const OTHER = "0xBbbbbbbBBBbbBbBBbbbbbbBbBbbbbBBbbBBBbBBB";

    it("verifies a payment to a payTo nobody registered", async () => {
      const body = structuredClone(validBody);
      body.paymentPayload.payload.authorization.to = STRANGER;
      body.paymentRequirements.payTo = STRANGER;
      const res = await handler(makeRequest({ body }));
      expect(res.status).toBe(200);
      const data: any = await res.json();
      expect(data.isValid).toBe(true);
    });

    it("rejects when the signed `to` disagrees with the declared payTo", async () => {
      const body = structuredClone(validBody);
      body.paymentPayload.payload.authorization.to = STRANGER;
      body.paymentRequirements.payTo = OTHER;
      const res = await handler(makeRequest({ body }));
      expect(res.status).toBe(400);
      const data: any = await res.json();
      expect(data.invalidReason).toBe("invalid_pay_to");
    });
  });
});
