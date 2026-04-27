import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSet = vi.hoisted(() => vi.fn());

vi.mock("@upstash/redis", () => ({
  Redis: class {
    set = mockSet;
    constructor(_opts: { url: string; token: string }) {}
  },
}));

let claimNonce: typeof import("../replay.js").claimNonce;

const params = {
  chainId: 137,
  contractAddress: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
  from: "0x1111111111111111111111111111111111111111",
  nonce: "0x" + "aa".repeat(32),
  validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "fake-token");
  vi.stubEnv("REPLAY_FAIL_OPEN", "");
  ({ claimNonce } = await import("../replay.js"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("claimNonce — Redis healthy", () => {
  it("ok=true mode=normal when SET NX succeeds", async () => {
    mockSet.mockResolvedValueOnce("OK");
    const result = await claimNonce(params);
    expect(result).toEqual({ ok: true, mode: "normal" });
  });

  it("ok=false mode=normal when SET NX returns null (replay)", async () => {
    mockSet.mockResolvedValueOnce(null);
    const result = await claimNonce(params);
    expect(result).toEqual({ ok: false, mode: "normal" });
  });
});

describe("claimNonce — Redis error, fail-closed default", () => {
  it("ok=false mode=fail_closed when SET throws and REPLAY_FAIL_OPEN is unset", async () => {
    mockSet.mockRejectedValueOnce(new Error("ECONNRESET"));
    const result = await claimNonce(params);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("fail_closed");
    expect(result.error).toContain("ECONNRESET");
  });

  it("ok=false mode=fail_closed when REPLAY_FAIL_OPEN=false explicitly", async () => {
    vi.stubEnv("REPLAY_FAIL_OPEN", "false");
    vi.resetModules();
    ({ claimNonce } = await import("../replay.js"));
    mockSet.mockRejectedValueOnce(new Error("network down"));
    const result = await claimNonce(params);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("fail_closed");
  });
});

describe("claimNonce — Redis error, fail-open opt-in", () => {
  beforeEach(async () => {
    vi.stubEnv("REPLAY_FAIL_OPEN", "true");
    vi.resetModules();
    ({ claimNonce } = await import("../replay.js"));
  });

  it("ok=true mode=fail_open when SET throws", async () => {
    mockSet.mockRejectedValueOnce(new Error("ECONNRESET"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await claimNonce(params);
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("fail_open");
      expect(consoleErr).toHaveBeenCalled();
    } finally {
      consoleErr.mockRestore();
    }
  });
});

describe("claimNonce — Redis not configured", () => {
  it("returns fail_closed when env vars missing (default)", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.resetModules();
    ({ claimNonce } = await import("../replay.js"));
    const result = await claimNonce(params);
    expect(result.ok).toBe(false);
    expect(result.mode).toBe("fail_closed");
  });

  it("returns fail_open when env vars missing and REPLAY_FAIL_OPEN=true", async () => {
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    vi.stubEnv("REPLAY_FAIL_OPEN", "true");
    vi.resetModules();
    ({ claimNonce } = await import("../replay.js"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await claimNonce(params);
      expect(result.ok).toBe(true);
      expect(result.mode).toBe("fail_open");
    } finally {
      consoleErr.mockRestore();
    }
  });
});
