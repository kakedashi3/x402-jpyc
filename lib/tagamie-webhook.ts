// Best-effort notification to Tagamie's /api/webhooks/settle.
// Failures are logged but never propagated — settle response is the source of truth.

export interface TagamieWebhookPayload {
  txHash: string;
  chain: "polygon" | "base" | "ethereum" | "avalanche" | "kaia";
  payTo: string;
  payer: string;
  amountMinor: string;
  asset: "JPYC" | "USDC";
  taxRateBps?: number;
  blockNumber?: string;
  resource?: string;
  occurredAt: string;
}

export async function notifyTagamie(
  payload: TagamieWebhookPayload,
): Promise<void> {
  const url = process.env.TAGAMIE_WEBHOOK_URL;
  const secret = process.env.TAGAMIE_WEBHOOK_SECRET;
  if (!url || !secret) return; // not configured -> skip silently

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-secret": secret,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      console.warn(
        JSON.stringify({
          event: "tagamie_webhook_failed",
          status: res.status,
          body: text.slice(0, 200),
          txHash: payload.txHash,
        }),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        event: "tagamie_webhook_error",
        error: message,
        txHash: payload.txHash,
      }),
    );
  }
}
