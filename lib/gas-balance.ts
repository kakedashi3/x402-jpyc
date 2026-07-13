import { formatEther } from "viem";
import { getFacilitatorAccount, getPublicClient } from "./chain-config.js";
import type { ChainConfig } from "./chain-config.js";

/**
 * Can this facilitator actually pay to settle on this chain, right now?
 *
 * `/supported` used to answer from a config file: it listed five chains because
 * five chains were compiled in. Meanwhile the hot wallet held zero gas on two of
 * them, so a settle there would have failed at the exact moment money moved —
 * worse than a 404, because the caller has already integrated by then.
 *
 * A facilitator's advertised capability has to be read from the chain, not from
 * its own manifest. This module is that read.
 */

/**
 * `transferWithAuthorization` measures ~60–70k gas. Budget 120k so a chain is
 * only ever reported as ready when it can comfortably pay, not marginally.
 */
export const SETTLE_GAS_LIMIT = 120_000n;

export type Availability =
  | { available: true; settlesAffordable: number; native: string }
  | {
      available: false;
      reason: "not_offered" | "insufficient_facilitator_gas" | "unreachable";
      settlesAffordable: number;
      native: string;
    };

/**
 * Estimate how many settlements the facilitator wallet can still pay for on
 * `chain`. Returns 0 (and `insufficient_facilitator_gas`) when it cannot afford
 * even one.
 */
export async function chainAvailability(
  chain: ChainConfig,
  offered: boolean,
): Promise<Availability> {
  if (!offered) {
    return {
      available: false,
      reason: "not_offered",
      settlesAffordable: 0,
      native: "0",
    };
  }

  const account = getFacilitatorAccount();
  if (!account) {
    return {
      available: false,
      reason: "unreachable",
      settlesAffordable: 0,
      native: "0",
    };
  }

  try {
    const client = getPublicClient(chain);
    const [balance, gasPrice] = await Promise.all([
      client.getBalance({ address: account.address }),
      client.getGasPrice(),
    ]);
    const costPerSettle = gasPrice * SETTLE_GAS_LIMIT;
    const affordable =
      costPerSettle > 0n ? Number(balance / costPerSettle) : 0;
    const native = formatEther(balance);

    if (affordable < 1) {
      return {
        available: false,
        reason: "insufficient_facilitator_gas",
        settlesAffordable: 0,
        native,
      };
    }
    return { available: true, settlesAffordable: affordable, native };
  } catch {
    // RPC down, or the chain is not configured on this instance.
    return {
      available: false,
      reason: "unreachable",
      settlesAffordable: 0,
      native: "0",
    };
  }
}
