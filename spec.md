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

- `paymentPayload.x402Version` ∈ {1, 2}
- `paymentPayload.scheme` = `"exact"` and `paymentRequirements.scheme` = `"exact"`
- `paymentPayload.network` = `paymentRequirements.network` = `"eip155:137"`
- `paymentRequirements.extra.name` = `"JPY Coin"` if present
- `paymentRequirements.extra.version` = `"1"` if present
- `paymentRequirements.asset` checksummed = JPYC contract
- `paymentRequirements.payTo` checksummed = recipient bound to the API key
- `authorization.to` checksummed = recipient bound to the API key
- `authorization.value` ≥ `paymentRequirements.amount`, both > 0
- `validAfter` ≤ now ≤ `validBefore` (when non-zero)
- EIP-712 signature recovers to `authorization.from`
- `authorizationState(from, nonce)` on-chain returns `false`

## Authentication

- Header: `x-api-key`
- Hash: SHA-256 of the raw header value (hex, lowercase)
- Match against `api_keys.api_key_hash` where `is_active = true`
- The destination of every transfer is `api_keys.recipient_address` for the matched row. The caller cannot override it.

## Replay Protection

- Backend: Upstash Redis
- Operation: `SET <key> "1" EX <ttl> NX`
- Key: `replay:137:<contract_lowercase>:<from_lowercase>:<nonce_lowercase>`
- TTL: `max(validBefore - now, 1)` seconds when `validBefore > 0`, else `86400`
- On Redis error or missing config: fail open. The on-chain `authorizationState` check remains the authoritative replay guard.

## Error Responses

| Status | Cause |
|---|---|
| 400 | Validation failure (schema, signature, addresses, amount, expiry, replay) |
| 401 | Missing or unrecognized `x-api-key` |
| 405 | Wrong HTTP method |
| 500 | Internal failure (RPC unavailable, contract revert during settle) |
| 503 | Service not configured (missing `POLYGON_RPC_URL` or `FACILITATOR_PRIVATE_KEY`) |

Error body:

```json
{ "error": "<message>" }
```

## References

- x402: https://x402.org
- EIP-3009: https://eips.ethereum.org/EIPS/eip-3009
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
