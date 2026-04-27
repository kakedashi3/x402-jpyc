import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInsert = vi.hoisted(() => vi.fn());
const mockUpdateEq = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn(() => ({ eq: mockUpdateEq })));
const mockFrom = vi.hoisted(() =>
  vi.fn(() => ({ insert: mockInsert, update: mockUpdate })),
);
const mockWaitUntil = vi.hoisted(() => vi.fn());

vi.mock("../supabase.js", () => ({
  supabase: { from: mockFrom },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mockWaitUntil,
}));

let logUsage: typeof import("../usage-log.js").logUsage;

beforeEach(async () => {
  vi.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  mockUpdateEq.mockResolvedValue({ error: null });
  ({ logUsage } = await import("../usage-log.js"));
});

afterEach(() => {
  vi.resetModules();
});

describe("logUsage", () => {
  it("returns synchronously without awaiting Supabase", () => {
    let resolved = false;
    mockInsert.mockReturnValue(
      new Promise<{ error: null }>((resolve) =>
        setTimeout(() => {
          resolved = true;
          resolve({ error: null });
        }, 1000),
      ),
    );

    const t0 = Date.now();
    logUsage({ apiKeyId: "k", event: "settle_success" });
    const dt = Date.now() - t0;

    // Synchronous return — no awaiting the slow insert.
    expect(dt).toBeLessThan(50);
    expect(resolved).toBe(false);
  });

  it("hands the in-flight promise to waitUntil", () => {
    logUsage({ apiKeyId: "k1", event: "verify_success" });
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    expect(mockWaitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
  });

  it("invokes insert and update with the right shape", async () => {
    const fixedNow = "2026-04-27T00:00:00.000Z";
    logUsage({
      apiKeyId: "key-id-1",
      event: "settle_success",
      createdAt: fixedNow,
    });

    // Allow the queued microtasks to drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockFrom).toHaveBeenCalledWith("api_key_usage");
    expect(mockFrom).toHaveBeenCalledWith("api_keys");
    expect(mockInsert).toHaveBeenCalledWith({
      api_key_id: "key-id-1",
      event: "settle_success",
      created_at: fixedNow,
    });
    expect(mockUpdate).toHaveBeenCalledWith({ last_used_at: fixedNow });
    expect(mockUpdateEq).toHaveBeenCalledWith("id", "key-id-1");
  });

  it("swallows Supabase errors and logs them", async () => {
    mockInsert.mockRejectedValueOnce(new Error("supabase down"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});

    let captured: Promise<unknown> | undefined;
    mockWaitUntil.mockImplementation((p) => {
      captured = p;
    });

    logUsage({ apiKeyId: "k", event: "verify_success" });
    await captured;

    expect(consoleErr).toHaveBeenCalled();
    const logged = consoleErr.mock.calls[0][0];
    expect(typeof logged).toBe("string");
    expect(logged).toContain("usage_log_failed");
    expect(logged).toContain("supabase down");

    consoleErr.mockRestore();
  });

  it("swallows waitUntil errors (non-Vercel runtime)", () => {
    mockWaitUntil.mockImplementation(() => {
      throw new Error("missing context");
    });

    // Must not throw out of logUsage.
    expect(() =>
      logUsage({ apiKeyId: "k", event: "verify_success" }),
    ).not.toThrow();
  });
});
