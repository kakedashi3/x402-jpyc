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
 * them. One settlement is roughly:
 *
 *   Kaia       ¥0.03      Polygon    ¥0.06
 *   Avalanche  ¥5.25      Ethereum   ¥252
 *
 * A single shared budget of 1,000 settlements/day is ¥63 of exposure on Polygon
 * and ¥252,000 on Ethereum. So each chain gets a cap sized to what a free public
 * service can afford to give away, and every cap is published in `/supported`.
 *
 * Ethereum mainnet is deliberately tiny: sponsoring ¥252 of gas to move a ¥100
 * micropayment is not a service, it is a leak. x402 on L1 barely makes economic
 * sense in the first place — settle on Polygon or Kaia, or self-host and raise
 * the cap to whatever your own wallet can bear.
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

/** Sponsored settlements per UTC day, by chain id. Env overrides per chain. */
export function budgetForChain(chainId: number): number {
  const override = process.env[`DAILY_SETTLE_BUDGET_${chainId}`];
  if (override !== undefined) return Number(override);
  switch (chainId) {
    case 1: // Ethereum — ~¥252/settle. 10/day ≈ ¥2,500 worst case.
      return Number(process.env.DAILY_SETTLE_BUDGET_ETHEREUM ?? 10);
    case 43114: // Avalanche — ~¥5.25/settle. 100/day ≈ ¥525.
      return 100;
    case 137: // Polygon — ~¥0.06/settle. 5,000/day ≈ ¥300.
    case 8217: // Kaia — ~¥0.03/settle. 5,000/day ≈ ¥150.
    case 80002: // Amoy testnet — free.
      return 5000;
    default:
      return 100;
  }
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
