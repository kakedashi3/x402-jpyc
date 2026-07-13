import { getRedis } from "./redis.js";

/**
 * Rate limiting for the open facilitator.
 *
 * yen402 used to gate `/verify` and `/settle` behind an API key. That key was
 * never protecting funds — `authorization.to` is inside the buyer's EIP-3009
 * signature, so the facilitator cannot redirect a payment — it was protecting
 * the facilitator's own sponsored gas. Every other facilitator in the x402
 * directory (PayAI, Dexter, Mogami, HPP) is open and defends the same asset
 * with rate limits plus a published gas budget instead. So do we.
 *
 * Two independent windows, both must pass:
 *   - per caller IP        — stops a single client hammering the endpoint
 *   - per payer (`from`)   — stops one funded wallet monopolising the budget
 *
 * Fails OPEN on Redis trouble: an infra hiccup must not take the facilitator
 * offline. The gas budget (`gas-budget.ts`) fails closed and is the real
 * backstop, so failing open here cannot become unbounded spend.
 */

/** Sustained rate, requests per second (PayAI publishes 4 rps on its free tier). */
export const RATE_LIMIT_RPS = Number(process.env.RATE_LIMIT_RPS ?? 4);
/** Burst allowance per minute (PayAI publishes 480/min). */
export const RATE_LIMIT_BURST_PER_MIN = Number(
  process.env.RATE_LIMIT_BURST_PER_MIN ?? 480,
);

export interface RateLimitResult {
  ok: boolean;
  /** Which window rejected, for the error body. */
  scope?: "ip" | "payer";
  window?: "second" | "minute";
  limit?: number;
  /** Seconds until the caller may retry. */
  retryAfter?: number;
}

const OK: RateLimitResult = { ok: true };

/**
 * Fixed-window counter. Cheap (one INCR + one EXPIRE on first hit) and good
 * enough: the gas budget bounds the worst case, so we do not need the extra
 * round-trips of a sliding window.
 */
async function hit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<number | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const k = `rl:${key}:${bucket}`;
    const count = await client.incr(k);
    if (count === 1) await client.expire(k, windowSeconds + 1);
    return count > limit ? -1 : count;
  } catch (err) {
    // Fail open — see module docstring.
    console.error("[RATELIMIT] fail-open (Redis error):", err);
    return null;
  }
}

export interface RateLimitParams {
  /** Caller IP, from `x-forwarded-for`. */
  ip: string | null;
  /** Payer address from the authorization, when the body has been parsed. */
  payer?: string | null;
}

export async function checkRateLimit(
  p: RateLimitParams,
): Promise<RateLimitResult> {
  const subjects: Array<{
    scope: "ip" | "payer";
    id: string;
  }> = [];
  if (p.ip) subjects.push({ scope: "ip", id: p.ip });
  if (p.payer) subjects.push({ scope: "payer", id: p.payer.toLowerCase() });

  for (const s of subjects) {
    const perSecond = await hit(`${s.scope}:${s.id}:s`, RATE_LIMIT_RPS, 1);
    if (perSecond === -1) {
      return {
        ok: false,
        scope: s.scope,
        window: "second",
        limit: RATE_LIMIT_RPS,
        retryAfter: 1,
      };
    }
    const perMinute = await hit(
      `${s.scope}:${s.id}:m`,
      RATE_LIMIT_BURST_PER_MIN,
      60,
    );
    if (perMinute === -1) {
      return {
        ok: false,
        scope: s.scope,
        window: "minute",
        limit: RATE_LIMIT_BURST_PER_MIN,
        retryAfter: 60,
      };
    }
  }
  return OK;
}

/** Extract the caller IP from an edge request. */
export function callerIp(req: Request): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;
  const first = xff.split(",")[0]?.trim();
  return first || null;
}
