import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the verification function
vi.mock("../../lib/jpyc.js", () => ({
  verifyJPYCPayment: vi.fn(),
}));

import handler from "../verify.js";
import { verifyJPYCPayment } from "../../lib/jpyc.js";

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
      body: options.body !== undefined ? JSON.stringify(options.body) : "invalid json{",
    }),
  });
}

describe("POST /api/verify handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("API_KEY", "test-secret");
  });

  it("returns 405 for non-POST methods", async () => {
    const res = await handler(
      new Request("https://example.com/api/verify", { method: "GET" })
    );
    expect(res.status).toBe(405);
  });

  it("returns 503 when API_KEY is not configured", async () => {
    vi.stubEnv("API_KEY", "");
    const res = await handler(
      makeRequest({ method: "POST", body: {} })
    );
    expect(res.status).toBe(503);
  });

  it("returns 401 when X-API-Key header is missing", async () => {
    const res = await handler(
      makeRequest({ method: "POST", body: {} })
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when X-API-Key header is wrong", async () => {
    const res = await handler(
      makeRequest({ method: "POST", apiKey: "wrong-key", body: {} })
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

  it("returns 400 when paymentPayload is missing", async () => {
    const res = await handler(
      makeRequest({
        apiKey: "test-secret",
        body: { paymentRequirements: {} },
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when paymentRequirements is missing", async () => {
    const res = await handler(
      makeRequest({
        apiKey: "test-secret",
        body: { paymentPayload: { payload: { txHash: "0x123" } } },
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when txHash is missing", async () => {
    const res = await handler(
      makeRequest({
        apiKey: "test-secret",
        body: {
          paymentPayload: { payload: {} },
          paymentRequirements: {},
        },
      })
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("txHash");
  });

  it("returns 200 with verification result on success", async () => {
    vi.mocked(verifyJPYCPayment).mockResolvedValue({
      isValid: true,
      txHash: "0xaaa" as `0x${string}`,
      amount: "1000",
      paidAt: "2025-01-01T00:00:00.000Z",
    });

    const res = await handler(
      makeRequest({
        apiKey: "test-secret",
        body: {
          paymentPayload: {
            scheme: "evm-erc20-transfer",
            network: "eip155:137",
            payload: { txHash: "0xaaa" },
          },
          paymentRequirements: {
            scheme: "evm-erc20-transfer",
            network: "eip155:137",
            asset: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
            amount: "1000",
            payTo: "0x1234",
          },
        },
      })
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.isValid).toBe(true);
  });

  it("returns 500 on unexpected error without leaking details", async () => {
    vi.mocked(verifyJPYCPayment).mockRejectedValue(
      new Error("RPC internal: secret connection string xyz")
    );

    const res = await handler(
      makeRequest({
        apiKey: "test-secret",
        body: {
          paymentPayload: {
            payload: { txHash: "0xaaa" },
          },
          paymentRequirements: {},
        },
      })
    );
    expect(res.status).toBe(500);
    const data: any = await res.json();
    expect(data.error).toBe("Internal server error");
    expect(JSON.stringify(data)).not.toContain("secret");
  });
});
