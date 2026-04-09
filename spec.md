# x402 JPYC Facilitator Specification

## Overview

This facilitator implements the [x402 protocol](https://x402.org) for verifying JPYC (JPY Coin) ERC-20 transfer payments on Polygon. It provides a `/verify` endpoint that resource servers can call to confirm that a client has made a valid JPYC payment.

## Scheme: `evm-erc20-transfer`

Unlike the standard x402 `exact` scheme (which uses EIP-3009 `transferWithAuthorization`), this facilitator uses the `evm-erc20-transfer` scheme. This scheme verifies on-chain ERC-20 `Transfer` events directly from transaction receipts, making it compatible with any ERC-20 token including JPYC.

### Why not the `exact` scheme?

The JPYC contract on Polygon (`0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`) does not implement EIP-3009. The following on-chain queries against the contract all revert:

| Function | Result |
|---|---|
| `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` | revert |
| `RECEIVE_WITH_AUTHORIZATION_TYPEHASH()` | revert |
| `CANCEL_AUTHORIZATION_TYPEHASH()` | revert |

Verified via `scripts/check-eip3009.ts` against Polygon RPC.

Without EIP-3009 support, the `exact` scheme's `transferWithAuthorization` flow cannot be used. The `evm-erc20-transfer` scheme was designed as an alternative that verifies completed on-chain transfers via `Transfer(address,address,uint256)` event logs, rather than relying on pre-signed authorization. This is the technical rationale for the x402-jpyc independent implementation.

## Network

- **Chain**: Polygon PoS (Chain ID: 137)
- **CAIP-2**: `eip155:137`
- **JPYC Contract**: `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`
- **Decimals**: 18

## Endpoints

### `POST /api/verify`

Verifies that a JPYC payment has been made on Polygon.

#### Request

```json
{
  "paymentPayload": {
    "x402Version": 2,
    "scheme": "evm-erc20-transfer",
    "network": "eip155:137",
    "payload": {
      "txHash": "0xabc...def",
      "from": "0x1234...5678",
      "to": "0xabcd...ef01",
      "amount": "1000000000000000000"
    }
  },
  "paymentRequirements": {
    "scheme": "evm-erc20-transfer",
    "network": "eip155:137",
    "asset": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
    "amount": "1000000000000000000",
    "payTo": "0xabcd...ef01"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `paymentPayload.x402Version` | number | Protocol version (2) |
| `paymentPayload.scheme` | string | Must be `"evm-erc20-transfer"` |
| `paymentPayload.network` | string | Must be `"eip155:137"` (Polygon) |
| `paymentPayload.payload.txHash` | string | Transaction hash on Polygon |
| `paymentPayload.payload.from` | string | Claimed sender address |
| `paymentPayload.payload.to` | string | Claimed recipient address |
| `paymentPayload.payload.amount` | string | Claimed amount in atomic units (wei) |
| `paymentRequirements.scheme` | string | Must be `"evm-erc20-transfer"` |
| `paymentRequirements.network` | string | Must be `"eip155:137"` |
| `paymentRequirements.asset` | string | JPYC contract address |
| `paymentRequirements.amount` | string | Required minimum amount in atomic units |
| `paymentRequirements.payTo` | string | Required recipient address |

#### Response (Success)

```json
{
  "isValid": true,
  "txHash": "0xabc...def",
  "amount": "1000000000000000000",
  "paidAt": "2025-01-15T10:30:00.000Z"
}
```

#### Response (Failure)

```json
{
  "isValid": false,
  "txHash": "0xabc...def",
  "invalidReason": "no matching JPYC transfer to the required recipient with sufficient amount"
}
```

| Field | Type | Description |
|---|---|---|
| `isValid` | boolean | Whether the payment is valid |
| `txHash` | string | Transaction hash (if available) |
| `amount` | string | Actual transferred amount in atomic units (success only) |
| `paidAt` | string | ISO 8601 timestamp of the block (success only) |
| `invalidReason` | string | Reason for failure (failure only) |

### `GET /api/health`

Returns facilitator health status.

```json
{
  "status": "ok",
  "service": "x402-jpyc-facilitator",
  "network": "eip155:137",
  "asset": "JPYC",
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

## Authentication

The `/api/verify` endpoint supports API key authentication via the `X-API-Key` header.

- If `API_KEY` is set: requests without a valid `X-API-Key` header receive `401 Unauthorized`.
- If `API_KEY` is not set: the facilitator **refuses all requests** with `503 Service Unavailable`. This is a fail-closed default — the operator must explicitly configure an API key before the service will accept traffic.

## Verification Logic

The facilitator performs the following checks in order:

1. **Scheme validation** — Both `paymentPayload.scheme` and `paymentRequirements.scheme` must be `"evm-erc20-transfer"`
2. **Network validation** — `eip155:137` (Polygon) only
3. **Input validation** — `txHash` format, `from`/`payTo` address validity, `amount` is a positive integer
4. **Asset validation** — JPYC contract address must match
5. **Replay protection** — `txHash` must not have been previously settled (in-memory tracking; see Limitations)
6. **Transaction receipt** — Fetch from Polygon RPC, confirm `status: "success"`
7. **Transfer event parsing** — Decode `Transfer(address,address,uint256)` events from the JPYC contract
8. **Transfer matching** — At least one Transfer event must match all three conditions simultaneously: `from` matches `paymentPayload.payload.from`, `to` matches `paymentRequirements.payTo`, and `value` >= `paymentRequirements.amount`

## Replay Protection

The facilitator tracks settled `txHash` values to prevent the same transaction from being used for multiple verifications.

**Current implementation:** In-memory `Set` with a capacity of 100,000 entries. When capacity is reached, new verifications are rejected to prevent evicted hashes from being replayed.

**Limitations:**
- Not shared across Edge isolates. Each Vercel Edge instance maintains its own set.
- Lost when the isolate is recycled.
- For production deployments, replace with a persistent store (Vercel KV, Redis, or a database).

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `POLYGON_RPC_URL` | **Yes** | Polygon RPC endpoint. A dedicated provider (Alchemy, Infura, QuickNode) is strongly recommended. Public RPCs are not suitable for payment verification. |
| `API_KEY` | **Yes** | API key for authenticating requests. The service refuses all traffic if this is not set. |

## x402 Protocol Flow (with this facilitator)

```
Client                    Resource Server              Facilitator
  |                             |                          |
  |--- GET /resource ---------> |                          |
  |<-- 402 Payment Required --- |                          |
  |                             |                          |
  | (Client sends JPYC on Polygon)                         |
  |                             |                          |
  |--- GET /resource ---------->|                          |
  |    X-PAYMENT: {txHash,...}  |                          |
  |                             |--- POST /api/verify ---->|
  |                             |<-- { isValid: true } ----|
  |<-- 200 OK + content ------- |                          |
```
