import { Redis } from "@upstash/redis";

/**
 * Upstash Redis-based replay protection for EIP-3009 authorizations.
 *
 * Key format: replay:137:{contractAddress}:{from}:{nonce}
 * TTL: validBefore - now  (or 86400s default when validBefore=0)
 *
 * Uses SET NX for atomic claim. Fails open on Redis errors so that a
 * Redis outage does not take down the payment service — the on-chain
 * authorizationState check remains the final line of defense.
 *
 * On transaction revert the key is NOT released (fail-safe).
 */

const CHAIN_ID = "137";

let _redis: Redis | null = null;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

export interface ReplayParams {
  contractAddress: string;
  from: string;
  nonce: string;
  validBefore: bigint;
}

function makeKey(p: ReplayParams): string {
  return `replay:${CHAIN_ID}:${p.contractAddress.toLowerCase()}:${p.from.toLowerCase()}:${p.nonce.toLowerCase()}`;
}

/**
 * Atomically claim a nonce to prevent replay attacks.
 *
 * Returns true  — nonce successfully claimed (not a replay, proceed).
 * Returns false — nonce already claimed (replay detected, reject).
 * Returns true  — Redis unavailable, fail open (on-chain check is authoritative).
 */
export async function claimNonce(params: ReplayParams): Promise<boolean> {
  const client = getRedis();
  if (!client) {
    console.error(
      "[replay] Redis not configured (UPSTASH_REDIS_REST_URL/TOKEN missing), skipping replay check"
    );
    return true;
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
    return result !== null;
  } catch (err) {
    console.error(
      "[replay] Redis error:",
      err instanceof Error ? err.message : String(err)
    );
    return true; // fail open
  }
}
