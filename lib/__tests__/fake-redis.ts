import { vi } from "vitest";

/**
 * In-memory stand-in for Upstash Redis.
 *
 * The open facilitator defends its sponsored gas with a rate limiter and a
 * daily budget instead of an API key, and both live in Redis. Mocking those
 * two modules away would mean the controls that replaced authentication are
 * never actually exercised — so we fake the store and run the real logic.
 */
export function createFakeRedis() {
  const store = new Map<string, number | string>();
  return {
    store,
    async incr(key: string): Promise<number> {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    async decr(key: string): Promise<number> {
      const next = Number(store.get(key) ?? 0) - 1;
      store.set(key, next);
      return next;
    },
    async expire(_key: string, _seconds: number): Promise<number> {
      return 1;
    },
    async get<T>(key: string): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async set(
      key: string,
      value: string,
      opts?: { ex?: number; nx?: boolean },
    ): Promise<string | null> {
      if (opts?.nx && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    /** Pretend today's gas budget is already spent. */
    exhaustBudget(limit: number) {
      const key = `gasbudget:${new Date().toISOString().slice(0, 10)}`;
      store.set(key, limit);
    },
    reset() {
      store.clear();
    },
  };
}

export type FakeRedis = ReturnType<typeof createFakeRedis>;

/** `vi.hoisted`-safe factory for `vi.mock("../../lib/redis.js", ...)`. */
export function fakeRedisModule(fake: FakeRedis) {
  return {
    getRedis: vi.fn(() => fake),
    resetRedisForTests: vi.fn(),
  };
}
