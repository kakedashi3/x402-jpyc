import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMOY,
  ChainNotSupportedError,
  POLYGON,
  SUPPORTED_CHAIN_IDS,
  isSupportedChainId,
  resolveChain,
  resolveChainByNetworkId,
} from "../chain-config.js";

describe("chain registry", () => {
  it("exposes Polygon mainnet (137) and Amoy (80002)", () => {
    expect(SUPPORTED_CHAIN_IDS).toEqual([137, 80002]);
    expect(POLYGON.chainId).toBe(137);
    expect(POLYGON.networkId).toBe("eip155:137");
    expect(POLYGON.jpycDecimals).toBe(18);
    expect(AMOY.chainId).toBe(80002);
    expect(AMOY.networkId).toBe("eip155:80002");
    expect(AMOY.jpycDecimals).toBe(18);
  });

  it("Polygon and Amoy share the JPYC proxy address", () => {
    expect(AMOY.jpycAddress.toLowerCase()).toBe(
      POLYGON.jpycAddress.toLowerCase(),
    );
  });

  it("share the EIP-712 domain (name + version)", () => {
    expect(AMOY.eip712Name).toBe(POLYGON.eip712Name);
    expect(AMOY.eip712Version).toBe(POLYGON.eip712Version);
  });
});

describe("resolveChain", () => {
  it("returns the Polygon config for 137", () => {
    expect(resolveChain(137)).toBe(POLYGON);
  });

  it("returns the Amoy config for 80002", () => {
    expect(resolveChain(80002)).toBe(AMOY);
  });

  it("throws ChainNotSupportedError for unknown chains", () => {
    expect(() => resolveChain(1)).toThrow(ChainNotSupportedError);
    expect(() => resolveChain(8453)).toThrow(ChainNotSupportedError);
  });
});

describe("resolveChainByNetworkId", () => {
  it("parses eip155:N", () => {
    expect(resolveChainByNetworkId("eip155:137")).toBe(POLYGON);
    expect(resolveChainByNetworkId("eip155:80002")).toBe(AMOY);
  });

  it("rejects malformed network ids", () => {
    expect(() => resolveChainByNetworkId("polygon")).toThrow(
      ChainNotSupportedError,
    );
    expect(() => resolveChainByNetworkId("eip155:not-a-number")).toThrow(
      ChainNotSupportedError,
    );
  });

  it("rejects unknown eip155 chain ids", () => {
    expect(() => resolveChainByNetworkId("eip155:1")).toThrow(
      ChainNotSupportedError,
    );
  });
});

describe("isSupportedChainId", () => {
  it.each([
    [137, true],
    [80002, true],
    [1, false],
    [8453, false],
    [0, false],
  ])("isSupportedChainId(%i) = %s", (id, expected) => {
    expect(isSupportedChainId(id)).toBe(expected);
  });
});

describe("getPublicClient / getWalletClient env handling", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws if the chain's RPC env var is unset", async () => {
    vi.stubEnv("POLYGON_RPC_URL", "");
    const { getPublicClient, POLYGON: P } = await import("../chain-config.js");
    expect(() => getPublicClient(P)).toThrow(/POLYGON_RPC_URL/);
  });

  it("throws on Amoy when AMOY_RPC_URL is unset", async () => {
    vi.stubEnv("AMOY_RPC_URL", "");
    const { getPublicClient, AMOY: A } = await import("../chain-config.js");
    expect(() => getPublicClient(A)).toThrow(/AMOY_RPC_URL/);
  });

  it("getFacilitatorAccount returns null when no key", async () => {
    vi.stubEnv("FACILITATOR_PRIVATE_KEY", "");
    const { getFacilitatorAccount } = await import("../chain-config.js");
    expect(getFacilitatorAccount()).toBeNull();
  });
});
