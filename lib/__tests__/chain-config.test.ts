import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMOY,
  AVALANCHE,
  ChainNotSupportedError,
  ETHEREUM,
  KAIA,
  POLYGON,
  SUPPORTED_CHAIN_IDS,
  isSupportedChainId,
  resolveChain,
  resolveChainByNetworkId,
} from "../chain-config.js";

describe("chain registry", () => {
  it("exposes Ethereum (1), Polygon (137), Amoy (80002), Avalanche (43114) and Kaia (8217)", () => {
    expect(SUPPORTED_CHAIN_IDS).toEqual([1, 137, 80002, 43114, 8217]);
    expect(POLYGON.chainId).toBe(137);
    expect(POLYGON.networkId).toBe("eip155:137");
    expect(POLYGON.jpycDecimals).toBe(18);
    expect(AMOY.chainId).toBe(80002);
    expect(AMOY.networkId).toBe("eip155:80002");
    expect(AMOY.jpycDecimals).toBe(18);
    expect(ETHEREUM.chainId).toBe(1);
    expect(ETHEREUM.networkId).toBe("eip155:1");
    expect(ETHEREUM.jpycDecimals).toBe(18);
    expect(AVALANCHE.chainId).toBe(43114);
    expect(AVALANCHE.networkId).toBe("eip155:43114");
    expect(AVALANCHE.jpycDecimals).toBe(18);
    expect(KAIA.chainId).toBe(8217);
    expect(KAIA.networkId).toBe("eip155:8217");
    expect(KAIA.jpycDecimals).toBe(18);
  });

  it("all chains share the JPYC proxy address (deterministic deployment)", () => {
    const polyAddr = POLYGON.jpycAddress.toLowerCase();
    expect(AMOY.jpycAddress.toLowerCase()).toBe(polyAddr);
    expect(ETHEREUM.jpycAddress.toLowerCase()).toBe(polyAddr);
    expect(AVALANCHE.jpycAddress.toLowerCase()).toBe(polyAddr);
    expect(KAIA.jpycAddress.toLowerCase()).toBe(polyAddr);
  });

  it("all chains share the EIP-712 domain (name + version)", () => {
    for (const c of [AMOY, ETHEREUM, AVALANCHE, KAIA]) {
      expect(c.eip712Name).toBe(POLYGON.eip712Name);
      expect(c.eip712Version).toBe(POLYGON.eip712Version);
    }
  });

  it("isMainnet is true for all mainnet chains and false for testnets", () => {
    expect(POLYGON.isMainnet).toBe(true);
    expect(ETHEREUM.isMainnet).toBe(true);
    expect(AVALANCHE.isMainnet).toBe(true);
    expect(KAIA.isMainnet).toBe(true);
    expect(AMOY.isMainnet).toBe(false);
  });
});

describe("resolveChain", () => {
  it("returns the right config for each supported chain id", () => {
    expect(resolveChain(1)).toBe(ETHEREUM);
    expect(resolveChain(137)).toBe(POLYGON);
    expect(resolveChain(80002)).toBe(AMOY);
    expect(resolveChain(43114)).toBe(AVALANCHE);
    expect(resolveChain(8217)).toBe(KAIA);
  });

  it("throws ChainNotSupportedError for unknown chains", () => {
    expect(() => resolveChain(8453)).toThrow(ChainNotSupportedError);
    expect(() => resolveChain(56)).toThrow(ChainNotSupportedError);
    expect(() => resolveChain(0)).toThrow(ChainNotSupportedError);
  });
});

describe("resolveChainByNetworkId", () => {
  it("parses eip155:N for every supported chain", () => {
    expect(resolveChainByNetworkId("eip155:1")).toBe(ETHEREUM);
    expect(resolveChainByNetworkId("eip155:137")).toBe(POLYGON);
    expect(resolveChainByNetworkId("eip155:80002")).toBe(AMOY);
    expect(resolveChainByNetworkId("eip155:43114")).toBe(AVALANCHE);
    expect(resolveChainByNetworkId("eip155:8217")).toBe(KAIA);
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
    expect(() => resolveChainByNetworkId("eip155:8453")).toThrow(
      ChainNotSupportedError,
    );
  });
});

describe("isSupportedChainId", () => {
  it.each([
    [1, true],
    [137, true],
    [80002, true],
    [43114, true],
    [8217, true],
    [8453, false],
    [56, false],
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

  it("throws on Ethereum when ETHEREUM_RPC_URL is unset", async () => {
    vi.stubEnv("ETHEREUM_RPC_URL", "");
    const { getPublicClient, ETHEREUM: E } = await import("../chain-config.js");
    expect(() => getPublicClient(E)).toThrow(/ETHEREUM_RPC_URL/);
  });

  it("throws on Avalanche when AVALANCHE_RPC_URL is unset", async () => {
    vi.stubEnv("AVALANCHE_RPC_URL", "");
    const { getPublicClient, AVALANCHE: A } = await import(
      "../chain-config.js"
    );
    expect(() => getPublicClient(A)).toThrow(/AVALANCHE_RPC_URL/);
  });

  it("throws on Kaia when KAIA_RPC_URL is unset", async () => {
    vi.stubEnv("KAIA_RPC_URL", "");
    const { getPublicClient, KAIA: K } = await import("../chain-config.js");
    expect(() => getPublicClient(K)).toThrow(/KAIA_RPC_URL/);
  });

  it("getFacilitatorAccount returns null when no key", async () => {
    vi.stubEnv("FACILITATOR_PRIVATE_KEY", "");
    const { getFacilitatorAccount } = await import("../chain-config.js");
    expect(getFacilitatorAccount()).toBeNull();
  });
});
