import { POLYGON } from "./chain-config.js";
import type { PaymentRequestBody } from "./payment-validation.js";

/**
 * Resolve which chain a request is for, from the payment itself.
 *
 * Before the facilitator was opened, the chain came from `api_keys.chain_id` —
 * a row in Supabase. That coupled "which chain can you settle on" to "which key
 * did you register", so one seller could only ever use one chain, and no
 * stranger could use any. The chain is already in the wire format; read it.
 *
 * x402 v1 puts `network` at the top of `paymentPayload`; v2 nests it under
 * `accepted`. `paymentRequirements.network` is authoritative when present —
 * `validatePayment` separately asserts that the payload agrees with it, so a
 * mismatch is caught rather than silently resolved to the wrong chain.
 */
export function networkFromBody(body: PaymentRequestBody): string {
  return (
    body?.paymentRequirements?.network ??
    body?.paymentPayload?.network ??
    body?.paymentPayload?.accepted?.network ??
    POLYGON.networkId
  );
}
