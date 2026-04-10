export default function handler(req: Request): Response {
  if (req.method !== "GET") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  return Response.json({
    status: "ok",
    service: "x402-jpyc-facilitator",
    network: "eip155:137",
    asset: "JPYC",
    timestamp: new Date().toISOString(),
  });
}
