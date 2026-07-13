import { getRedis } from "./redis.js";
import { SUPPORTED_CHAIN_IDS, resolveChain } from "./chain-config.js";

/**
 * Daily sponsored-settlement budget, PER CHAIN.
 *
 * yen402 pays the on-chain gas for every `/settle` (the buyer signs an EIP-3009
 * authorization; the facilitator broadcasts `transferWithAuthorization`). With
 * the API key gone, a stranger can spend that gas — so the loss has to be
 * *bounded and published*, the way Dexter publishes "0.005 ETH gas sponsored
 * /day".
 *
 * The budget MUST be per chain, because gas is not remotely comparable across
 * them. Measured 2026-07-13 at ~65k gas per settlement:
 *
 *   Kaia     27 gwei → ~¥0.03      Polygon  282 gwei → ~¥0.55
 *
 * Those are point-in-time readings and they MOVE. An earlier version of this
 * comment guessed ¥0.06 for Polygon and was wrong by 9x, which is exactly why
 * no number here should be trusted: `/supported` reads the wallet and reports
 * what we can actually afford, and `gas-balance.ts` is the check that enforces
 * it. Estimates go stale; the chain does not.
 *
 * Which means the budget only caps the RATE. What bounds the actual loss is the
 * gas we choose to fund the wallet with — `chainAvailability()` refuses to
 * broadcast when the wallet cannot pay, so an unfunded chain costs a stranger
 * nothing, and costs us nothing.
 *
 * Fails CLOSED on Redis trouble: never broadcast gas we cannot account for.
 * (The rate limiter fails open — it is a courtesy control. This is the wallet.)
 *
 * Griefing math, for the record: to make the facilitator broadcast at all, a
 * caller needs a valid, unused, unexpired signature with balance — and such a
 * transaction SUCCEEDS, moving real JPYC to the recipient the payer signed. An
 * attacker would be spending their own JPYC to burn our gas. The only pure-burn
 * vector is racing the nonce between pre-check and broadcast, which `replay.ts`
 * already closes with an atomic Redis claim.
 */

/**
 * Sponsored settlements per UTC day, by chain id. `0` means the public instance
 * does not offer that chain at all.
 *
 * **Ethereum and Avalanche are not offered.** Not because the code cannot settle
 * there — it can, and a self-hoster should — but because L1 gas costs orders of
 * magnitude more than the micropayments x402 exists for. Sponsoring it is a leak
 * with a nice UI. JPYC's real x402 volume is on Polygon and Kaia, and those are
 * the chains where a sponsored facilitator makes economic sense.
 *
 * Advertising a chain you will not fund is worse than not listing it: the caller
 * finds out at the moment money moves. Set `DAILY_SETTLE_BUDGET_1=100` (and fund
 * the wallet) to offer Ethereum from your own instance.
 */
export function budgetForChain(chainId: number): number {
  const override = process.env[`DAILY_SETTLE_BUDGET_${chainId}`];
  if (override !== undefined) return Number(override);
  switch (chainId) {
    case 137: // Polygon — the main JPYC x402 rail.
    case 8217: // Kaia — LINE / Unifi distribution.
    case 80002: // Amoy testnet — gas is free, so cap it generously.
      return 5000;
    case 1: // Ethereum — L1 gas dwarfs a micropayment. Self-host to enable.
    case 43114: // Avalanche — same. Self-host to enable.
      return 0;
    default:
      return 0;
  }
}

/** Does this instance offer settlement on this chain at all? */
export function isChainOffered(chainId: number): boolean {
  return budgetForChain(chainId) > 0;
}

export type BudgetMode = "normal" | "fail_closed";

export interface BudgetResult {
  ok: boolean;
  mode: BudgetMode;
  /** Settlements consumed on this chain today, including this one when ok. */
  used?: number;
  limit: number;
  error?: string;
}

function todayKey(chainId: number): string {
  // UTC day bucket, so the published reset time is unambiguous.
  return `gasbudget:${chainId}:${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Atomically reserve one settlement from this chain's budget for today.
 *
 * Call immediately before broadcasting. On a pre-broadcast failure call
 * `releaseSettlement()` so a dead RPC does not eat the day's budget.
 */
export async function reserveSettlement(
  chainId: number,
): Promise<BudgetResult> {
  const limit = budgetForChain(chainId);
  const client = getRedis();
  if (!client) {
    return {
      ok: false,
      mode: "fail_closed",
      limit,
      error: "Redis not configured (UPSTASH_REDIS_REST_URL/TOKEN missing)",
    };
  }
  if (limit <= 0) {
    return { ok: false, mode: "normal", used: 0, limit };
  }
  const key = todayKey(chainId);
  try {
    const used = await client.incr(key);
    if (used === 1) await client.expire(key, 172800); // 2 days, covers rollover
    if (used > limit) {
      return { ok: false, mode: "normal", used, limit };
    }
    return { ok: true, mode: "normal", used, limit };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GASBUDGET] fail-closed (Redis error):", message);
    return { ok: false, mode: "fail_closed", limit, error: message };
  }
}

/** Give a reservation back when we never broadcast. Best-effort. */
export async function releaseSettlement(chainId: number): Promise<void> {
  const client = getRedis();
  if (!client) return;
  try {
    await client.decr(todayKey(chainId));
  } catch (err) {
    console.error("[GASBUDGET] release failed (harmless):", err);
  }
}

/** Per-chain consumption without reserving. Used by `/supported`. */
export async function budgetStatus(): Promise<
  Array<{ network: string; chainId: number; used: number; limit: number }>
> {
  const client = getRedis();
  const out = [];
  for (const chainId of SUPPORTED_CHAIN_IDS) {
    const limit = budgetForChain(chainId);
    let used = 0;
    if (client) {
      try {
        used = Number((await client.get<number>(todayKey(chainId))) ?? 0);
      } catch {
        used = 0;
      }
    }
    out.push({
      network: resolveChain(chainId).networkId,
      chainId,
      used,
      limit,
    });
  }
  return out;
}
