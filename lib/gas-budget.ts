import { getRedis } from "./redis.js";

/**
 * Daily sponsored-gas budget for the open facilitator.
 *
 * yen402 pays the on-chain gas for every `/settle` (the buyer signs an EIP-3009
 * authorization; the facilitator broadcasts `transferWithAuthorization`). With
 * the API key gone, a stranger can spend that gas — so the loss has to be
 * *bounded and published*, the way Dexter publishes "0.5 SOL gas sponsored/day".
 * This is that bound, and it is the real backstop behind the rate limiter.
 *
 * Budgeted in settlements rather than wei: `transferWithAuthorization` gas is
 * near-constant, the edge runtime cannot cheaply read receipts, and a count is
 * a number we can actually put in the docs.
 *
 * Fails CLOSED on Redis trouble: never broadcast gas we cannot account for.
 * (The rate limiter fails open — it is a courtesy control, this is the wallet.)
 *
 * Griefing math, for the record: to make the facilitator broadcast at all, a
 * caller needs a valid, unused, unexpired signature with balance — and such a
 * transaction SUCCEEDS, moving real JPYC to the recipient the payer signed. An
 * attacker would be spending their own JPYC to burn our sub-cent of gas. The
 * only pure-burn vector is racing the nonce between pre-check and broadcast,
 * which `replay.ts` already closes with an atomic Redis claim.
 */

/** Sponsored settlements per UTC day. Published in `/supported` and the README. */
export const DAILY_SETTLE_BUDGET = Number(
  process.env.DAILY_SETTLE_BUDGET ?? 1000,
);

export type BudgetMode = "normal" | "fail_closed";

export interface BudgetResult {
  ok: boolean;
  mode: BudgetMode;
  /** Settlements consumed today, including this one when ok. */
  used?: number;
  limit: number;
  error?: string;
}

function todayKey(): string {
  // UTC day bucket, so the published reset time is unambiguous.
  return `gasbudget:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Atomically reserve one settlement from today's budget.
 *
 * Call immediately before broadcasting. On a pre-broadcast failure call
 * `releaseSettlement()` so a dead RPC does not eat the day's budget.
 */
export async function reserveSettlement(): Promise<BudgetResult> {
  const client = getRedis();
  if (!client) {
    return {
      ok: false,
      mode: "fail_closed",
      limit: DAILY_SETTLE_BUDGET,
      error: "Redis not configured (UPSTASH_REDIS_REST_URL/TOKEN missing)",
    };
  }
  const key = todayKey();
  try {
    const used = await client.incr(key);
    if (used === 1) await client.expire(key, 172800); // 2 days, covers the rollover
    if (used > DAILY_SETTLE_BUDGET) {
      return { ok: false, mode: "normal", used, limit: DAILY_SETTLE_BUDGET };
    }
    return { ok: true, mode: "normal", used, limit: DAILY_SETTLE_BUDGET };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GASBUDGET] fail-closed (Redis error):", message);
    return {
      ok: false,
      mode: "fail_closed",
      limit: DAILY_SETTLE_BUDGET,
      error: message,
    };
  }
}

/** Give a reservation back when we never broadcast. Best-effort. */
export async function releaseSettlement(): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.decr(todayKey());
  } catch (err) {
    console.error("[GASBUDGET] release failed (harmless):", err);
  }
}

/** Read today's consumption without reserving. Used by `/supported`. */
export async function budgetStatus(): Promise<{
  used: number;
  limit: number;
}> {
  const client = getRedis();
  if (!client) return { used: 0, limit: DAILY_SETTLE_BUDGET };
  try {
    const used = await client.get<number>(todayKey());
    return { used: Number(used ?? 0), limit: DAILY_SETTLE_BUDGET };
  } catch {
    return { used: 0, limit: DAILY_SETTLE_BUDGET };
  }
}
