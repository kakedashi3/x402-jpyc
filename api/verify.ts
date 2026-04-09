import { verifyJPYCPayment, type VerifyRequest } from "../lib/jpyc.js";

export const config = {
  runtime: "edge",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // API key authentication (fail-closed: no key configured = no traffic)
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    return json({ error: "Service not configured" }, 503);
  }
  const provided = req.headers.get("x-api-key");
  if (provided !== apiKey) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.paymentPayload || !body.paymentRequirements) {
    return json(
      { error: "Missing required fields: paymentPayload, paymentRequirements" },
      400
    );
  }

  if (!body.paymentPayload.payload?.txHash) {
    return json(
      { error: "Missing required field: paymentPayload.payload.txHash" },
      400
    );
  }

  try {
    const result = await verifyJPYCPayment(body);
    return json(result);
  } catch {
    return json({ error: "Internal server error" }, 500);
  }
}
