export const config = {
  runtime: "edge",
};

import { verifyJPYCPayment } from "../lib/jpyc.js";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return json({ error: "Service not configured" }, 503);
  }

  const provided = req.headers.get("x-api-key");
  if (!provided || !timingSafeEqual(provided, apiKey)) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { paymentPayload, paymentRequirements } = body as {
    paymentPayload?: { payload?: { txHash?: string } };
    paymentRequirements?: unknown;
  };

  if (!paymentPayload) {
    return json({ error: "Missing required field: paymentPayload" }, 400);
  }

  if (!paymentRequirements) {
    return json({ error: "Missing required field: paymentRequirements" }, 400);
  }

  if (!paymentPayload.payload?.txHash) {
    return json(
      { error: "Missing required field: paymentPayload.payload.txHash" },
      400
    );
  }

  try {
    const result = await verifyJPYCPayment(body as any);
    return json(result);
  } catch (err) {
    console.error("[verify] unexpected error:", err instanceof Error ? err.message : "unknown");
    return json({ error: "Internal server error" }, 500);
  }
}
