import { Redis } from "@upstash/redis";

/**
 * Shared Upstash Redis client.
 *
 * Extracted from `replay.ts` when the facilitator became open (no API key):
 * replay protection, rate limiting and the sponsored-gas budget all need the
 * same connection, and an open endpoint must not open three of them.
 *
 * Returns `null` when Redis is not configured. Each caller decides what that
 * means for it — replay fails closed (never risk a double broadcast), the rate
 * limiter fails open (never lock everyone out over an infra hiccup), and the
 * gas budget fails closed (never spend unbounded gas we cannot account for).
 */

let _redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

/** Test seam: drop the memoised client so env changes take effect. */
export function resetRedisForTests(): void {
  _redis = null;
}
