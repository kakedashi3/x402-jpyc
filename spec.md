# Facilitator Specification

Wire-level specification of the x402-jpyc facilitator. Authoritative source for request/response shapes, on-chain calls, and operational behavior.

## Implementation

| Field | Value |
|---|---|
| Name | `x402-jpyc-facilitator` |
| Protocol | x402 v2 |
| Runtime | Vercel Edge Functions |
| Base URL | `https://x402-jpyc.vercel.app` |

## Asset

| Field | Value |
|---|---|
| Name | JPYC (JPY Coin) |
| Network | Polygon |
| Network ID | `eip155:137` |
| Contract | `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29` |
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
  "chainId": 137,
  "verifyingContract": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29"
}
```

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

### Responses

`POST /verify` 200:

```json
{ "isValid": true, "payer": "0x<address>" }
```

`POST /settle` 200:

```json
{ "success": true, "txHash": "0x<bytes32>", "network": "eip155:137" }
```

`GET /health` 200:

```json
{
  "status": "ok",
  "service": "x402-jpyc-facilitator",
  "network": "eip155:137",
  "asset": "JPYC",
  "timestamp": "<ISO8601>"
}
```

`GET /payment-info` 200:

```json
{
  "recipientAddress": "0x<address>",
  "network": "eip155:137",
  "token": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29"
}
```

## Validation Rules

Static checks (`validatePayment`):

- `paymentPayload.x402Version` ∈ {1, 2}
- `paymentPayload.scheme` = `"exact"` and `paymentRequirements.scheme` = `"exact"`
- `paymentPayload.network` = `paymentRequirements.network` = `"eip155:137"`
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

Error body:

```json
{ "error": "<human readable>", "code": "<error_code>" }
```

### Error code catalog

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_request` | 400 | Malformed JSON or missing required fields |
| `invalid_x402_version` | 400 | `x402Version` not in {1, 2} |
| `invalid_scheme` | 400 | `scheme` is not `"exact"` |
| `invalid_chain_id` | 400 | `network` is not `"eip155:137"` |
| `invalid_extra` | 400 | `extra.name` or `extra.version` mismatch |
| `invalid_asset` | 400 | `asset` is not the JPYC contract |
| `invalid_address` | 400 | `from` or `to` is not a valid address |
| `invalid_pay_to` | 400 | `payTo` or `authorization.to` does not match the API key's bound recipient |
| `invalid_amount` | 400 | `value` < `amount`, or either is zero/non-positive |
| `invalid_nonce_format` | 400 | `nonce` is not a 32-byte hex string |
| `authorization_expired` | 400 | `validBefore` ≤ now |
| `authorization_not_yet_valid` | 400 | `validAfter` > now |
| `invalid_signature` | 400 | EIP-712 signature does not recover to `from`, or signature length is wrong |
| `nonce_already_used` | 400 | `authorizationState(from, nonce)` returned true on-chain |
| `simulation_failed` | 400 | `simulateContract` or `estimateContractGas` reverted |
| `simulation_timeout` | 503 | On-chain simulation exceeded 3 seconds |
| `facilitator_insufficient_native_balance` | 503 | Facilitator MATIC balance below estimated gas cost |
| `rpc_unavailable` | 503 | RPC error reading authorizationState, balance, or gas price |

## References

- x402: https://x402.org
- EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
