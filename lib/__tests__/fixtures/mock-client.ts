import { vi, type Mock } from "vitest";
import type { PublicClient } from "viem";

export interface MockPublicClient {
  readContract: Mock;
  simulateContract: Mock;
  estimateContractGas: Mock;
  getBalance: Mock;
  getGasPrice: Mock;
}

/**
 * Build a `PublicClient` test double pre-stubbed so the happy path
 * through `simulateTransferWithAuthorization` succeeds. Per-test
 * assertions override individual methods with `mockResolvedValue`/
 * `mockRejectedValue`/`mockImplementation`.
 *
 * Defaults:
 *  - `authorizationState` → false (nonce unused)
 *  - `simulateContract`   → no revert
 *  - `estimateContractGas` → 80_000 gas
 *  - `getBalance`         → 1 MATIC (10^18 wei)
 *  - `getGasPrice`        → 50 gwei
 */
export function createMockPublicClient(): MockPublicClient {
  return {
    readContract: vi.fn().mockResolvedValue(false),
    simulateContract: vi.fn().mockResolvedValue({ result: undefined }),
    estimateContractGas: vi.fn().mockResolvedValue(80_000n),
    getBalance: vi.fn().mockResolvedValue(10n ** 18n),
    getGasPrice: vi.fn().mockResolvedValue(50n * 10n ** 9n),
  };
}

export function asPublicClient(mock: MockPublicClient): PublicClient {
  return mock as unknown as PublicClient;
}
