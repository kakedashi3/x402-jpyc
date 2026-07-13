/**
 * CORS for the open facilitator.
 *
 * The facilitator is a public utility now, so browser-based clients must be
 * able to call it directly (HPP documents the same: "CORS is enabled, so
 * browser-based clients can call the facilitator directly"). Nothing here is
 * credentialed — there is no cookie, no API key — so `*` is the honest value.
 */
export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
}

/** Answer a CORS preflight, or return null if this is not one. */
export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders() });
}
