export const config = {
  runtime: "edge",
};

import { SUPPORTED_CHAIN_IDS, resolveChain } from "../lib/chain-config.js";

export default function handler(req: Request): Response {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  return Response.json({
    status: "ok",
    service: "x402-jpyc-facilitator",
    networks: SUPPORTED_CHAIN_IDS.map((id) => {
      const c = resolveChain(id);
      return { chainId: c.chainId, network: c.networkId, name: c.name };
    }),
    asset: "JPYC",
    timestamp: new Date().toISOString(),
  });
}
