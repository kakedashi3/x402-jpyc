import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const mockSingle = vi.hoisted(() => vi.fn());
const mockVerifyTypedData = vi.hoisted(() => vi.fn());

vi.mock("../../lib/supabase.js", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: mockSingle,
          }),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  },
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

const mockPublicClient = {
  readContract: vi.fn(),
};

// Stub env before importing handler
vi.stubEnv("POLYGON_RPC_URL", "https://fake-rpc.test");
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
  value: "1000000000000000000",
  validAfter: "0",
  validBefore: String(Math.floor(Date.now() / 1000) + 3600),
  nonce: "0x" + "aa".repeat(32),
};

const validSignature = "0x" + "bb".repeat(65);

const validBody = {
  paymentPayload: {
    x402Version: 1,
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
    vi.stubEnv("API_KEY", "test-secret");
    mockSingle.mockResolvedValue({
      data: { id: "key-id", user_id: "user-id" },
      error: null,
    });
    mockVerifyTypedData.mockResolvedValue(true);
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await handler(
      new Request("https://example.com/api/verify", { method: "GET" }),
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
    const req = new Request("https://example.com/api/verify", {
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

  it("returns 200 with isValid and payer on success", async () => {
    mockPublicClient.readContract.mockResolvedValue(false); // nonce not used

    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: validBody }),
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.isValid).toBe(true);
    expect(data.payer).toBe("0x1111111111111111111111111111111111111111");
    expect(data.txHash).toBeUndefined();
  });

  it("returns 500 when authorizationState RPC call fails", async () => {
    mockPublicClient.readContract.mockRejectedValue(new Error("RPC error"));

    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: validBody }),
    );
    expect(res.status).toBe(500);
    const data: any = await res.json();
    expect(data.error).toContain("authorization state");
  });

  it("returns 400 when signature does not match from", async () => {
    mockPublicClient.readContract.mockResolvedValue(false);
    mockVerifyTypedData.mockResolvedValue(false);

    const res = await handler(
      makeRequest({ apiKey: "test-secret", body: validBody }),
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("Signature");
    expect(data.isValid).toBeUndefined();
  });
});
