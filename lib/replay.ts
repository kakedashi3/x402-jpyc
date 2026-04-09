import type { Hash } from "viem";

/**
 * In-memory replay protection for settled txHashes.
 *
 * Limitations:
 * - Not shared across Vercel Edge instances. Each isolate has its own set.
 * - Evicted when the isolate is recycled.
 * - When capacity is reached, new verifications are rejected rather than
 *   evicting old entries (which would reopen them to replay).
 *
 * For production, replace with a persistent store (e.g. Vercel KV, Redis,
 * or a database) and call markSettled / hasSettled against that store.
 */

const settled = new Set<Hash>();

const MAX_ENTRIES = 100_000;

export function hasSettled(txHash: Hash): boolean {
  return settled.has(txHash);
}

export function isFull(): boolean {
  return settled.size >= MAX_ENTRIES;
}

export function markSettled(txHash: Hash): void {
  settled.add(txHash);
}
