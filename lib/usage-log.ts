import { waitUntil } from "@vercel/functions";
import { supabase } from "./supabase.js";

/**
 * Best-effort usage logging.
 *
 * The on-chain transaction is the source of truth for billing; this
 * table is only used for dashboards and rate-limit signals. Insert
 * failures must never block the verify/settle response, so we hand
 * the write to the Vercel runtime via `waitUntil` and swallow errors
 * (logging them to stderr for the operator).
 *
 * In non-Vercel environments (`vercel dev`, vitest, raw Node) the
 * `waitUntil` import is still callable but may throw "missing context";
 * we swallow that too — the promise has already been kicked off and
 * will resolve in the background.
 */

export type UsageEvent = "verify_success" | "settle_success";

export interface UsageEventInput {
  apiKeyId: string;
  event: UsageEvent;
  /** Override the timestamp (testing only). */
  createdAt?: string;
}

export function logUsage(evt: UsageEventInput): void {
  const now = evt.createdAt ?? new Date().toISOString();

  const promise = (async () => {
    try {
      await Promise.all([
        supabase.from("api_key_usage").insert({
          api_key_id: evt.apiKeyId,
          event: evt.event,
          created_at: now,
        }),
        supabase
          .from("api_keys")
          .update({ last_used_at: now })
          .eq("id", evt.apiKeyId),
      ]);
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "usage_log_failed",
          apiKeyId: evt.apiKeyId,
          usageEvent: evt.event,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  })();

  try {
    waitUntil(promise);
  } catch {
    // Outside a Vercel request context (local dev, tests). The promise
    // is already running; we just can't ask the runtime to wait on it.
  }
}
