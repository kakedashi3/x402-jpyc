[![CI](https://github.com/kakedashi3/x402-jpyc/actions/workflows/ci.yml/badge.svg)](https://github.com/kakedashi3/x402-jpyc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# x402-jpyc

x402 facilitator for JPYC (JPY Coin) on Polygon. Lets HTTP APIs charge in JPYC and lets clients pay with an EIP-3009 signed authorization.

[日本語版 README](./README.ja.md)

## Endpoints

Hosted at `https://x402-jpyc.vercel.app`. Both the short form and the `/api/*` form work (Vercel rewrites).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/verify` | Validate an EIP-3009 payment authorization |
| `POST` | `/settle` | Validate, then submit `transferWithAuthorization` on-chain |
| `GET`  | `/health` | Health check |
| `GET`  | `/payment-info` | Return the recipient address bound to the API key |

## Quick Start — Server

Install the x402 v2 middleware:

```bash
npm install @x402/express @x402/core @x402/evm viem
```

Accept JPYC payments on an Express route:

```typescript
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const app = express();

const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://x402-jpyc.vercel.app",
});

const server = new x402ResourceServer(facilitatorClient).register(
  "eip155:137",
  new ExactEvmScheme(),
);

app.use(
  paymentMiddleware(
    {
      "GET /api/data": {
        accepts: [
          {
            scheme: "exact",
            network: "eip155:137",
            asset: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", // JPYC (JPY Coin)
            amount: "1000000000000000000", // 1 JPYC (18 decimals)
            payTo: "0xYOUR_WALLET_ADDRESS",
            extra: {
              assetTransferMethod: "eip3009",
              name: "JPY Coin",
              version: "1",
            },
          },
        ],
        description: "Paid data",
        mimeType: "application/json",
      },
    },
    server,
  ),
);

app.get("/api/data", (req, res) => {
  res.json({ message: "Paid content delivered" });
});

app.listen(3000);
```

## Quick Start — Client

Sign an EIP-3009 authorization with viem and call the paid API:

```typescript
import { createWalletClient, http, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const JPYC_ADDRESS = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";
const PAY_TO = "0xRECIPIENT_WALLET_ADDRESS";

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const client = createWalletClient({
  account,
  chain: polygon,
  transport: http("https://polygon-bor-rpc.publicnode.com"),
});

const amount = parseUnits("1", 18); // 1 JPYC
const validAfter = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour
const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));

const signature = await client.signTypedData({
  domain: {
    name: "JPY Coin",
    version: "1",
    chainId: 137,
    verifyingContract: JPYC_ADDRESS,
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: account.address,
    to: PAY_TO,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  },
});

const response = await fetch("https://your-server.com/api/data", {
  headers: {
    "X-PAYMENT": JSON.stringify({
      paymentPayload: {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:137",
        payload: {
          signature,
          authorization: {
            from: account.address,
            to: PAY_TO,
            value: amount.toString(),
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
            nonce,
          },
        },
      },
      paymentRequirements: {
        scheme: "exact",
        network: "eip155:137",
        asset: JPYC_ADDRESS,
        amount: amount.toString(),
        payTo: PAY_TO,
        extra: {
          assetTransferMethod: "eip3009",
          name: "JPY Coin",
          version: "1",
        },
      },
    }),
  },
});

console.log(await response.json());
```

## API Reference

### `POST /verify`

Validates a payment authorization. Does not broadcast.

```bash
curl -X POST https://x402-jpyc.vercel.app/verify \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "paymentPayload": {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:137",
      "payload": {
        "signature": "0xEIP712_SIGNATURE",
        "authorization": {
          "from": "0xSENDER_ADDRESS",
          "to": "0xRECIPIENT_ADDRESS",
          "value": "1000000000000000000",
          "validAfter": "0",
          "validBefore": "1800000000",
          "nonce": "0xRANDOM_BYTES32"
        }
      }
    },
    "paymentRequirements": {
      "scheme": "exact",
      "network": "eip155:137",
      "asset": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
      "amount": "1000000000000000000",
      "payTo": "0xRECIPIENT_ADDRESS",
      "extra": {
        "assetTransferMethod": "eip3009",
        "name": "JPY Coin",
        "version": "1"
      }
    }
  }'
```

Response:

```json
{ "isValid": true, "payer": "0xSENDER_ADDRESS" }
```

### `POST /settle`

Validates, then submits `transferWithAuthorization` on Polygon. Same request body as `/verify`.

Response:

```json
{ "success": true, "txHash": "0x...", "network": "eip155:137" }
```

### `GET /payment-info`

Returns the recipient address registered for the API key.

```bash
curl https://x402-jpyc.vercel.app/payment-info \
  -H "x-api-key: YOUR_API_KEY"
```

```json
{
  "recipientAddress": "0xYOUR_RECIPIENT_ADDRESS",
  "network": "eip155:137",
  "token": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29"
}
```

### `GET /health`

```json
{
  "status": "ok",
  "service": "x402-jpyc-facilitator",
  "network": "eip155:137",
  "asset": "JPYC",
  "timestamp": "2026-04-27T00:00:00.000Z"
}
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `FACILITATOR_PRIVATE_KEY` | Yes | Wallet private key used to broadcast `transferWithAuthorization` |
| `POLYGON_RPC_URL` | Yes | Polygon RPC endpoint (Alchemy / QuickNode recommended) |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-side only) |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST URL for nonce replay protection |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST token |

## API Key Management

API keys live in a Supabase `api_keys` table:

| Column | Description |
|---|---|
| `api_key_hash` | SHA-256 hash of the raw key (the raw key is never stored) |
| `api_key_prefix` | First few characters of the key for display |
| `recipient_address` | On-chain address that receives JPYC payments for this key |
| `is_active` | Toggle to revoke without deleting |

The `x-api-key` header is hashed on each request and matched against `api_key_hash`. The destination of every transfer is the `recipient_address` registered for that key — the caller cannot override it.

## Notes

- JPYC (JPY Coin) settlement uses EIP-3009 `transferWithAuthorization(...)`.
- The facilitator is the relayer; the payer signs an EIP-712 typed authorization off-chain.
- EIP-712 domain: `name: "JPY Coin"`, `version: "1"`, `chainId: 137`.
- Nonce replay protection: atomic `SET NX + TTL` in Upstash Redis, scoped by `chain:contract:from:nonce`. The TTL is derived from `validBefore`. On Redis unavailability the service fails open and the on-chain `authorizationState` check remains the final guard.
- `/settle` returns `txHash` immediately after broadcast.
- Runtime: Vercel Edge Functions.

## Example settlement

[Polygonscan: 0x35c00930…3432b8c8f](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f)

| Field | Value |
|---|---|
| tx hash | `0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f` |
| Block | 85338927 |
| Network | Polygon mainnet |

## License

MIT

## Disclaimer

> This project is an unofficial, individually-developed open source project. It is not an official content of JPYC Inc.
> "JPYC" is a stablecoin provided by JPYC Inc.
> "JPYC" and the JPYC logo are registered trademarks of JPYC Inc.
>
> ※ 本プロジェクトは個人開発による非公式のオープンソースプロジェクトです。JPYC 株式会社による公式コンテンツではありません。
> ※ 「JPYC」は JPYC 株式会社の提供するステーブルコインです。
> ※ JPYC 及び JPYC ロゴは、JPYC 株式会社の登録商標です。
