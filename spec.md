# Facilitator Specification

Wire-level specification of the x402-jpyc facilitator. Authoritative source for request/response shapes, on-chain calls, and operational behavior.

## Implementation

| Field | Value |
|---|---|
| Name | `x402-jpyc-facilitator` |
| Protocol | x402 v2 |
| Runtime | Vercel Edge Functions |
| Base URL | `https://yen402.com` |

## Supported networks

| Chain | `chain_id` | x402 `network` | RPC env var | JPYC contract | Decimals | Use case |
|---|---|---|---|---|---|---|
| Ethereum | `1` | `eip155:1` | `ETHEREUM_RPC_URL` | `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29` | 18 | Production |
| Polygon | `137` | `eip155:137` | `POLYGON_RPC_URL` | `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29` | 18 | Production |
| Polygon Amoy | `80002` | `eip155:80002` | `AMOY_RPC_URL` | `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29` | 18 | Testnet |
| Avalanche C-Chain | `43114` | `eip155:43114` | `AVALANCHE_RPC_URL` | `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29` | 18 | Production |
| Kaia | `8217` | `eip155:8217` | `KAIA_RPC_URL` | `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29` | 18 | Production |

JPYC is deployed at the same proxy address on all five chains (deterministic / cross-chain mirrored deployment); each implementation exposes EIP-3009 `transferWithAuthorization` with the EIP-712 domain `name="JPY Coin", version="1"` and 18 decimals.

> Operational note: code-level support does not imply mainnet liquidity. To actually settle on Ethereum / Avalanche / Kaia, the facilitator wallet (`FACILITATOR_PRIVATE_KEY`) must additionally hold native gas (ETH / AVAX / KAIA) on that chain. The buyer also needs a JPYC balance on the target chain at sign time; otherwise `simulateContract` will revert and `/verify` returns `simulation_failed`. Until those preconditions are met per chain, only Polygon mainnet is end-to-end live.

API keys are bound to a single chain via `api_keys.chain_id`. A key issued for one chain cannot settle on another; the request's `paymentRequirements.network` must match the key's chain or the response is `400 invalid_chain_id`. Migrations: `migrations/001_add_chain_id_to_api_keys.sql` (initial binding, 137/80002) and `migrations/003_extend_supported_chains.sql` (admits 1, 43114, 8217).

## Asset

| Field | Value |
|---|---|
| Name | JPYC (JPY Coin) |
| Decimals | 18 |

## Scheme

| Field | Value |
|---|---|
| `scheme` | `exact` |
| `assetTransferMethod` | `eip3009` |

## On-chain Calls

```
function transferWithAuthorization(
  address from,
  address to,
  uint256 value,
  uint256 validAfter,
  uint256 validBefore,
  bytes32 nonce,
  uint8 v,
  bytes32 r,
  bytes32 s
)

function authorizationState(address authorizer, bytes32 nonce)
  view returns (bool)
```

## EIP-712 Domain

```json
{
  "name": "JPY Coin",
  "version": "1",
  "chainId": <137 or 80002>,
  "verifyingContract": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29"
}
```

`chainId` matches the chain the API key is bound to. `name`, `version`, and `verifyingContract` are identical on Polygon mainnet and Amoy.

## EIP-712 Type

```
TransferWithAuthorization(
  address from,
  address to,
  uint256 value,
  uint256 validAfter,
  uint256 validBefore,
  bytes32 nonce
)
```

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/verify` | `x-api-key` | Validate authorization (no broadcast) |
| `POST` | `/settle` | `x-api-key` | Validate, then broadcast `transferWithAuthorization` |
| `GET`  | `/health` | none | Service health |
| `GET`  | `/payment-info` | `x-api-key` | Return recipient address bound to the key |

Both the short form and `/api/*` form resolve to the same handler (Vercel rewrites in `vercel.json`).

### Request body (verify, settle)

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "scheme": "exact",
    "network": "eip155:137",
    "payload": {
      "signature": "0x<65 bytes hex>",
      "authorization": {
        "from": "0x<address>",
        "to": "0x<address>",
        "value": "<uint256 string>",
        "validAfter": "<uint256 string>",
        "validBefore": "<uint256 string>",
        "nonce": "0x<bytes32>"
      }
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:137",
    "asset": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
    "amount": "<uint256 string>",
    "payTo": "0x<address>",
    "extra": {
      "assetTransferMethod": "eip3009",
      "name": "JPY Coin",
      "version": "1"
    }
  }
}
```

The top-level `x402Version` is optional. If present, it must equal `paymentPayload.x402Version` or the request is rejected with `invalid_x402_version`. This mirrors the v2 canonical envelope while preserving v1-style callers that only set the inner version.

### Responses

`POST /verify` 200:

```json
{ "isValid": true, "payer": "0x<address>" }
```

`POST /settle` 200:

```json
{
  "success": true,
  "payer": "0x<address>",
  "transaction": "0x<bytes32>",
  "txHash": "0x<bytes32>",
  "network": "eip155:137"
}
```

The `transaction` field is the v2 canonical name for the broadcast transaction hash; `txHash` is preserved as a legacy alias and will be removed in a future major version. Always read `transaction` for forward compatibility. The `network` field echoes the chain the API key is bound to (one of `eip155:1`, `eip155:137`, `eip155:80002`, `eip155:43114`, `eip155:8217`).

`GET /health` 200:

```json
{
  "status": "ok",
  "service": "x402-jpyc-facilitator",
  "networks": [
    { "chainId": 1,     "network": "eip155:1",     "name": "ethereum" },
    { "chainId": 137,   "network": "eip155:137",   "name": "polygon" },
    { "chainId": 80002, "network": "eip155:80002", "name": "amoy" },
    { "chainId": 43114, "network": "eip155:43114", "name": "avalanche" },
    { "chainId": 8217,  "network": "eip155:8217",  "name": "kaia" }
  ],
  "asset": "JPYC",
  "timestamp": "<ISO8601>"
}
```

`GET /payment-info` 200:

```json
{
  "recipientAddress": "0x<address>",
  "network": "eip155:137",
  "chainId": 137,
  "token": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
  "decimals": 18
}
```

## Validation Rules

Static checks (`validatePayment`):

- `paymentPayload.x402Version` ∈ {1, 2}
- `paymentPayload.scheme` = `"exact"` and `paymentRequirements.scheme` = `"exact"`
- `paymentPayload.network` = `paymentRequirements.network` = the network bound to the API key (`eip155:137` or `eip155:80002`)
- `paymentRequirements.extra.name` = `"JPY Coin"` if present
- `paymentRequirements.extra.version` = `"1"` if present
- `paymentRequirements.asset` checksummed = JPYC contract
- `paymentRequirements.payTo` checksummed = recipient bound to the API key
- `authorization.to` checksummed = recipient bound to the API key
- `authorization.nonce` matches `^0x[0-9a-fA-F]{64}$`
- `authorization.value` ≥ `paymentRequirements.amount`, both > 0
- `validAfter` ≤ now < `validBefore` (when non-zero)
- EIP-712 signature recovers to `authorization.from`
- `authorizationState(from, nonce)` on-chain returns `false`

On-chain pre-flight (`simulateTransferWithAuthorization`, run by `/verify`):

- `authorizationState(from, nonce)` re-checked (concurrency safety)
- `simulateContract(transferWithAuthorization, …)` does not revert
- `estimateContractGas` succeeds
- Facilitator native (MATIC) balance ≥ `gasEstimate * gasPrice`

The simulation has a hard 3-second timeout. On timeout the response is `503 simulation_timeout`, not a 4xx — a flaky RPC must not be reported as a malformed authorization.

## Amount validation policy

`exact` means exact. The facilitator accepts a payment only when:

```
authorization.value == paymentRequirements.amount
```

| `value` vs `amount` | Result |
|---|---|
| `value == amount` | accepted |
| `value != amount` (over or under) | rejected — `invalid_exact_evm_payload_authorization_value_mismatch` (`code: amount_mismatch`) |
| either is `0` or non-positive | rejected — `invalid_exact_evm_authorization_value` / `invalid_payment_requirements` (`code: invalid_amount`) |

The token moves whatever `value` the buyer signed, so an overpayment is not a margin — it is a payment for something else. This matches the x402 reference SDKs (TS/Go/Python) and the normative rule proposed in x402 #3925. (Until 2026-10 this facilitator accepted overpayment; that divergence is gone.)

The authorization must also stay valid long enough to settle: `validBefore` must be at least 6 seconds in the future at verification (same buffer as the reference SDKs). `validBefore = 0` is rejected — EIP-3009 requires `now < validBefore`, so it could only revert.

A plain 65-byte signature with `s > secp256k1n/2` (EIP-2 high-s) from a payer with no code is rejected (`invalid_exact_evm_non_canonical_signature`), mirroring Go #2454 / TS #2728 / Python #3912.

## Authentication

- Header: `x-api-key`
- Hash: SHA-256 of the raw header value (hex, lowercase)
- Match against `api_keys.api_key_hash` where `is_active = true`
- The destination of every transfer is `api_keys.recipient_address` for the matched row. The caller cannot override it.

## Usage logging

Successful `/verify` and `/settle` calls record a row in `api_key_usage` and bump `api_keys.last_used_at`. Both writes are **best-effort** and run via `waitUntil` on Vercel Edge — they are not awaited before the response is returned.

- Failures are logged to stderr as JSON with `event: "usage_log_failed"`; the response itself is unaffected.
- The on-chain transaction is the source of truth for billing. The usage table is only used for dashboards and rate-limit signals; **do not rely on it for accounting**.
- Outside the Vercel runtime (`vercel dev`, vitest, raw Node) `waitUntil` is a no-op; the write still runs but the host may not extend the request lifetime to wait for it.

## Replay Protection

- Backend: Upstash Redis
- Operation: `SET <key> "1" EX <ttl> NX`
- Key: `replay:137:<contract_lowercase>:<from_lowercase>:<nonce_lowercase>`
- TTL: `max(validBefore - now, 1)` seconds when `validBefore > 0`, else `86400`
- On transaction revert the key is **not** released (fail-safe).

### Failure mode

| `REPLAY_FAIL_OPEN` | Redis state | `claimNonce` returns | `/settle` response |
|---|---|---|---|
| unset / `false` | reachable, key new | `{ok:true, mode:"normal"}` | 200 + `X-Replay-Protection: normal` |
| unset / `false` | reachable, key exists | `{ok:false, mode:"normal"}` | 400 `nonce_already_used` |
| unset / `false` | unreachable / unconfigured | `{ok:false, mode:"fail_closed"}` | 503 `service_unavailable` (retriable) |
| `true` | unreachable / unconfigured | `{ok:true, mode:"fail_open"}` | 200 + `X-Replay-Protection: degraded` |

Default is **fail-closed**: if the replay store is down, `/settle` refuses to broadcast and returns 503 so the caller can retry. Operators who would rather keep accepting payments during a Redis outage can opt into the legacy fail-open path with `REPLAY_FAIL_OPEN=true`; in that mode every degraded settle is logged via `console.error` and the response carries `X-Replay-Protection: degraded`.

#### Why fail-closed by default

The on-chain `authorizationState` check is the final replay guard, but it cannot prevent a brief window of double-broadcast: under Edge cold-start contention plus a Redis outage, two concurrent `/settle` calls can both pass `authorizationState=false` and both submit transactions. Only one lands; the other reverts and consumes facilitator gas. For a payments SaaS, "settlement temporarily unavailable" is more acceptable than "we burned MATIC on a duplicate broadcast", so we fail-closed by default and let the operator opt out.

## Error Responses

| Status | Cause |
|---|---|
| 400 | Validation failure (schema, signature, addresses, amount, expiry, replay, simulation revert) |
| 401 | Missing or unrecognized `x-api-key` |
| 405 | Wrong HTTP method |
| 500 | Internal failure (contract revert during settle broadcast) |
| 503 | Service not configured, RPC unavailable, simulation timeout, or facilitator out of native balance |

Error body (verify):

```json
{
  "isValid": false,
  "invalidReason": "<x402 reason>",
  "invalidMessage": "<human readable>",
  "payer": "0x<address>",
  "error": "<human readable>",
  "code": "<yen402 code>"
}
```

Error body (settle):

```json
{
  "success": false,
  "errorReason": "<x402 reason>",
  "errorMessage": "<human readable>",
  "payer": "0x<address>",
  "transaction": "",
  "network": "eip155:137",
  "error": "<human readable>",
  "code": "<yen402 code>"
}
```

`invalidReason` / `errorReason` carry the code an x402 client matches on: the one the reference SDK (`@x402/evm` `exact/facilitator/errors.ts`) emits for the same condition, or a generic code from x402 v2 spec §9. Clients MUST match on these, never on message text. `code` is yen402's own finer diagnosis, kept for existing callers; `error` duplicates `invalidMessage` / `errorMessage` for the same reason. The `payer` field is included only once `from` is known.

`/settle` waits for the receipt (default 15 s, `SETTLE_RECEIPT_TIMEOUT_MS`). `success: true` means the transfer confirmed. If the transaction was broadcast but not confirmed in time, the response is `202` with `success: false`, `errorReason: "settlement_pending"` and the broadcast hash in `transaction` — reconcile on chain before retrying. A confirmed revert is `invalid_exact_evm_transaction_failed` with the hash.

### Error code catalog

| `code` (yen402) | `invalidReason` / `errorReason` (x402) | HTTP | Meaning |
|---|---|---|---|
| `invalid_request` | `invalid_payload` | 400 | Malformed JSON or missing required fields |
| `invalid_x402_version` | `invalid_x402_version` | 400 | `x402Version` not in {1, 2} |
| `invalid_scheme` | `invalid_exact_evm_scheme` | 400 | `scheme` is not `"exact"` |
| `invalid_chain_id` | `invalid_exact_evm_network_mismatch` | 400 | payload and requirements `network` disagree with the chain |
| `invalid_network` / `network_not_offered` | `invalid_network` | 400 | network not supported / not sponsored on this instance |
| `invalid_extra` | `invalid_exact_evm_missing_eip712_domain` | 400 | `extra.name` or `extra.version` mismatch |
| `invalid_asset` | `invalid_payment_requirements` | 400 | `asset` is not the JPYC contract |
| `invalid_pay_to` | `invalid_payment_requirements` | 400 | `payTo` missing or not an address |
| `recipient_mismatch` | `invalid_exact_evm_recipient_mismatch` | 400 | signed `authorization.to` ≠ `payTo` |
| `invalid_address` | `invalid_payload` | 400 | `from` or `to` is not a valid address |
| `invalid_amount` | `invalid_exact_evm_authorization_value` | 400 | `value` or `amount` zero/non-positive/malformed |
| `amount_mismatch` | `invalid_exact_evm_payload_authorization_value_mismatch` | 400 | `value` ≠ `amount` |
| `amount_below_minimum` | `amount_below_minimum` | 400 | below this instance's sponsored-gas floor (`MIN_SETTLE_JPYC`); no standard equivalent |
| `invalid_nonce_format` | `invalid_payload` | 400 | `nonce` is not a 32-byte hex string |
| `authorization_expired` | `invalid_exact_evm_payload_authorization_valid_before` | 400 | `validBefore` < now + 6 s |
| `authorization_not_yet_valid` | `invalid_exact_evm_payload_authorization_valid_after` | 400 | `validAfter` > now |
| `invalid_signature` | `invalid_exact_evm_signature` | 400 | signature does not recover to `from`, or is malformed |
| `non_canonical_signature` | `invalid_exact_evm_non_canonical_signature` | 400 | high-s signature from a payer with no code |
| `nonce_already_used` | `invalid_exact_evm_nonce_already_used` | 400 | `authorizationState(from, nonce)` is true, or nonce already claimed |
| `insufficient_funds` | `invalid_exact_evm_insufficient_balance` | 400 | simulation reverted and payer JPYC balance < `value` |
| `simulation_failed` | `invalid_exact_evm_transaction_simulation_failed` | 400 | `simulateContract` or `estimateContractGas` reverted |
| `transaction_failed` / `transaction_reverted` | `invalid_exact_evm_transaction_failed` | 500 / 400 | broadcast failed / confirmed revert |
| `settlement_pending` | `settlement_pending` | 202 | broadcast, not confirmed in time — reconcile with `transaction` |
| `simulation_timeout`, `rpc_unavailable`, `facilitator_insufficient_native_balance` | `unexpected_verify_error` | 503 | our side, not the payment |
| `rate_limited`, `budget_exhausted`, `service_unavailable`, `insufficient_facilitator_gas` | `unexpected_settle_error` (verify: `unexpected_verify_error`) | 429 / 503 | our side, not the payment |

## Compatibility with x402 v2 canonical wire format

This facilitator targets the v2 specification at `github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md` and `docs.x402.org/core-concepts/facilitator`. Differences and compatibility policy:

| Field | Canonical v2 | This facilitator | Policy |
|---|---|---|---|
| Request top-level `x402Version` | required | optional, but if present must match inner | accepts both v1-style and v2-style envelopes |
| `/settle` success tx field | `transaction` | both `transaction` and `txHash` | `txHash` deprecated; remove in next major |
| `/settle` success `payer` | required | included | matches |
| `/verify` failure `invalidReason` | required (string) | x402 reason (SDK/spec §9), plus `invalidMessage`; yen402's own `code` alongside | `code` kept for existing callers |
| `/settle` failure `errorReason` | required (string) | x402 reason (SDK/spec §9), plus `errorMessage`; yen402's own `code` alongside | `code` kept for existing callers |
| `payTo` dynamic per-request | supported by spec | rejected if not matching API key's bound recipient | intentional security choice — see "Authentication" |
| `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers | resource-server flow only | not applicable to facilitator HTTP API | n/a |

The fixed-recipient model (binding `payTo` to the API key) is a deliberate divergence: a stolen API key cannot redirect funds to an attacker-controlled wallet. Clients that need dynamic recipients must use a different facilitator.

## References

- x402: https://x402.org
- x402 v2 specification: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- x402 facilitator concept: https://docs.x402.org/core-concepts/facilitator
- EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
