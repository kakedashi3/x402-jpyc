import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";

/**
 * Single source of truth for per-chain configuration.
 *
 * `ChainConfig` is the static metadata required by validation and
 * EIP-712 signing — it never reads env vars, so it can be constructed
 * in tests without polluting the environment. The runtime helpers
 * (`getPublicClient`, `getWalletClient`) read env at call time.
 */

export type ChainId = 137 | 80002;

export const SUPPORTED_CHAIN_IDS: readonly ChainId[] = [137, 80002] as const;

export interface ChainConfig {
  chainId: ChainId;
  name: "polygon" | "amoy";
  networkId: string;
  jpycAddress: Address;
  jpycDecimals: number;
  eip712Name: string;
  eip712Version: string;
  scheme: "exact";
  /** Env var holding the RPC URL for this chain. */
  rpcEnvVar: "POLYGON_RPC_URL" | "AMOY_RPC_URL";
  /** viem `Chain` definition (used by createPublicClient/createWalletClient). */
  viemChain: Chain;
}

// JPYC is deployed at the same proxy address on Polygon mainnet and Amoy
// (deterministic deployment). Implementation behind both proxies exposes
// `transferWithAuthorization` (EIP-3009) and the EIP-712 domain
// `name="JPY Coin", version="1"`. Decimals = 18 on both chains.
// Source: https://amoy.polygonscan.com/address/0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29
const JPYC_ADDRESS: Address = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";

export const POLYGON: ChainConfig = {
  chainId: 137,
  name: "polygon",
  networkId: "eip155:137",
  jpycAddress: JPYC_ADDRESS,
  jpycDecimals: 18,
  eip712Name: "JPY Coin",
  eip712Version: "1",
  scheme: "exact",
  rpcEnvVar: "POLYGON_RPC_URL",
  viemChain: polygon,
};

export const AMOY: ChainConfig = {
  chainId: 80002,
  name: "amoy",
  networkId: "eip155:80002",
  jpycAddress: JPYC_ADDRESS,
  jpycDecimals: 18,
  eip712Name: "JPY Coin",
  eip712Version: "1",
  scheme: "exact",
  rpcEnvVar: "AMOY_RPC_URL",
  viemChain: polygonAmoy,
};

const REGISTRY: Record<ChainId, ChainConfig> = {
  137: POLYGON,
  80002: AMOY,
};

export class ChainNotSupportedError extends Error {
  readonly chainId: number;
  constructor(chainId: number) {
    super(`Chain ${chainId} is not supported`);
    this.name = "ChainNotSupportedError";
    this.chainId = chainId;
  }
}

export function isSupportedChainId(n: number): n is ChainId {
  return (SUPPORTED_CHAIN_IDS as readonly number[]).includes(n);
}

export function resolveChain(chainId: number): ChainConfig {
  if (!isSupportedChainId(chainId)) {
    throw new ChainNotSupportedError(chainId);
  }
  return REGISTRY[chainId];
}

export function resolveChainByNetworkId(networkId: string): ChainConfig {
  const m = /^eip155:(\d+)$/.exec(networkId);
  if (!m) throw new ChainNotSupportedError(0);
  return resolveChain(Number(m[1]));
}

function requireRpcUrl(chain: ChainConfig): string {
  const v = process.env[chain.rpcEnvVar];
  if (!v) {
    throw new Error(`Missing required env: ${chain.rpcEnvVar}`);
  }
  return v;
}

export function getPublicClient(chain: ChainConfig): PublicClient {
  const rpcUrl = requireRpcUrl(chain);
  return createPublicClient({ chain: chain.viemChain, transport: http(rpcUrl) });
}

export function getWalletClient(
  chain: ChainConfig,
  account: PrivateKeyAccount,
): WalletClient {
  const rpcUrl = requireRpcUrl(chain);
  return createWalletClient({
    account,
    chain: chain.viemChain,
    transport: http(rpcUrl),
  });
}

export function getFacilitatorAccount(): PrivateKeyAccount | null {
  const raw = process.env.FACILITATOR_PRIVATE_KEY;
  if (!raw) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  return privateKeyToAccount(key);
}
