import { createPublicClient, http, type PublicClient } from "viem";
import { polygon } from "viem/chains";

export const POLYGON_CHAIN_ID = 137;
export const POLYGON_NETWORK = "eip155:137";

let client: PublicClient | null = null;
let clientRpcUrl: string | null = null;

export function getPolygonClient(): PublicClient {
  const rpcUrl = process.env.POLYGON_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      "POLYGON_RPC_URL is not set. A reliable RPC endpoint is required."
    );
  }
  // Reuse client if RPC URL hasn't changed; recreate if env var updated
  if (!client || clientRpcUrl !== rpcUrl) {
    client = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl),
    });
    clientRpcUrl = rpcUrl;
  }
  return client;
}
