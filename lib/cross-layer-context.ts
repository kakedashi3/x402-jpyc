/**
 * Cross-Layer Context v1.0
 * Shared envelope passed between Discovery (paylog) / Payment (yen402) /
 * MCP bridge (yen402-mcp) / Accounting (Tagamie).
 *
 * Spec: knowledge/cross-layer-context.md
 *
 * Status in this repo: facilitator forwards context opaquely from clients
 * (settle request body) to the downstream Tagamie webhook. We do not
 * validate the inner structure — the receiver applies its own Zod schema.
 */
export interface CrossLayerContext {
  version: "1.0";
  intent?: string;
  service: {
    name: string;
    category?: string;
    endpoint?: string;
    counterparty_wallet: string;
  };
  description?: string;
  invoice_hints?: {
    tax_category?: "standard_10" | "reduced_8" | "exempt";
    receipt_id?: string;
  };
  source?: {
    discovery_layer: "paylog" | "manual" | "other";
    discovered_at?: string;
    trust_score_at_discovery?: number;
  };
}
