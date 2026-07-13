import { getRedis } from "./redis.js";

/**
 * Upstash Redis-based replay protection for EIP-3009 authorizations.
 *
 * Key format: replay:{chainId}:{contractAddress}:{from}:{nonce}
 * TTL: validBefore - now  (or 86400s default when validBefore=0)
 *
 * Atomic claim via SET NX. Default behavior on Redis error is
 * fail-closed: claimNonce returns ok=false so the caller refuses
 * to broadcast. Operators can opt into fail-open (legacy behavior)
 * by setting REPLAY_FAIL_OPEN=true.
 *
 * On transaction revert the key is NOT released (fail-safe).
 *
 * With the facilitator open (no API key), this atomic claim is also what makes
 * pure gas-burn griefing impractical: it closes the nonce race between the
 * on-chain pre-check and the broadcast.
 */

function failOpenEnabled(): boolean {
  return process.env.REPLAY_FAIL_OPEN === "true";
}

export interface ReplayParams {
  chainId: number;
  contractAddress: string;
  from: string;
  nonce: string;
  validBefore: bigint;
}

export type ClaimMode = "normal" | "fail_open" | "fail_closed";

export interface ClaimResult {
  ok: boolean;
  mode: ClaimMode;
  error?: string;
}

function makeKey(p: ReplayParams): string {
  return `replay:${p.chainId}:${p.contractAddress.toLowerCase()}:${p.from.toLowerCase()}:${p.nonce.toLowerCase()}`;
}

/**
 * Atomically claim a nonce to prevent replay attacks.
 *
 * Returns:
 *  - { ok: true,  mode: "normal" }       — newly claimed
 *  - { ok: false, mode: "normal" }       — already claimed (replay detected)
 *  - { ok: false, mode: "fail_closed" }  — Redis error; default — caller should 503
 *  - { ok: true,  mode: "fail_open" }    — Redis error + REPLAY_FAIL_OPEN=true
 *  - { ok: false, mode: "fail_closed" }  — Redis not configured (treated as outage)
 */
export async function claimNonce(params: ReplayParams): Promise<ClaimResult> {
  const client = getRedis();
  if (!client) {
    const msg = "Redis not configured (UPSTASH_REDIS_REST_URL/TOKEN missing)";
    if (failOpenEnabled()) {
      console.error("[REPLAY] fail-open triggered:", msg);
      return { ok: true, mode: "fail_open", error: msg };
    }
    return { ok: false, mode: "fail_closed", error: msg };
  }

  const key = makeKey(params);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const ttl =
    params.validBefore > 0n
      ? Math.max(Number(params.validBefore - now), 1)
      : 86400;

  try {
    // SET key "1" EX ttl NX
    // Returns "OK" when newly set, null when key already exists.
    const result = await client.set(key, "1", { ex: ttl, nx: true });
    return { ok: result !== null, mode: "normal" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (failOpenEnabled()) {
      console.error("[REPLAY] fail-open triggered:", message);
      return { ok: true, mode: "fail_open", error: message };
    }
    console.error("[REPLAY] fail-closed (Redis error):", message);
    return { ok: false, mode: "fail_closed", error: message };
  }
}
