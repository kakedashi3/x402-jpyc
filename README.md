[![CI](https://github.com/kakedashi3/x402-jpyc/actions/workflows/ci.yml/badge.svg)](https://github.com/kakedashi3/x402-jpyc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# x402-jpyc

A **free, open x402 facilitator for JPYC** (JPY Coin — the yen stablecoin). Lets HTTP APIs charge in yen and lets clients pay with an EIP-3009 signed authorization, with no gas of their own.

**No API key. No account. No fees.** Point your middleware at it:

```bash
FACILITATOR_URL=https://yen402.com
```

That is the whole setup. There is nothing to register — the recipient of a payment is the address the buyer *signed*, so the facilitator has no need to know who you are, and no ability to send your money anywhere else.

[日本語版 README](./README.ja.md)

## Endpoints

Hosted at `https://yen402.com`. Both the short form and the `/api/*` form work (Vercel rewrites). CORS is enabled, so browser clients can call it directly.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/verify` | Validate an EIP-3009 payment authorization (read-only) |
| `POST` | `/settle` | Validate, then submit `transferWithAuthorization` on-chain — yen402 pays the gas |
| `GET`  | `/supported` | Chains, asset, and the live limits below, as JSON |
| `GET`  | `/health` | Health check |

## Limits

yen402 sponsors the gas for every settlement, so the subsidy is bounded — and the bounds are published here rather than hidden behind a signup. Live values: [`/supported`](https://yen402.com/supported).

| Limit | Default | Why |
|---|---|---|
| Rate limit | 4 req/s, 480/min (per IP and per payer) | Stops one caller monopolising a shared service |
| Sponsored gas | **per chain** — see below | The hard bound on what an anonymous caller can cost us |
| Minimum settlement | ¥1 | Keeps sponsored gas a small fraction of the payment |

**The gas budget is per chain, because gas is not comparable across chains.**

| Chain | Sponsored settlements/day |
|---|---|
| Polygon (`eip155:137`) | 5,000 |
| Kaia (`eip155:8217`) | 5,000 |
| Polygon Amoy (testnet) | 5,000 |
| Ethereum (`eip155:1`) | **not offered** |
| Avalanche (`eip155:43114`) | **not offered** |

**Ethereum and Avalanche are not offered on the public instance.** The code settles there fine — but L1 gas costs orders of magnitude more than the micropayments x402 exists for, and JPYC's real x402 volume is on Polygon and Kaia. `/settle` on those networks returns `network_not_offered` rather than letting you discover it as a failed broadcast. Self-host and set `DAILY_SETTLE_BUDGET_1` to enable them.

### The real bound is the wallet, not the budget

The daily budget caps the *rate*. What actually bounds a stranger's cost to us is **the gas we choose to put in the facilitator wallet** — and `/settle` checks that it can pay before it reserves budget or broadcasts.

So do not trust a number printed in this README: gas prices move, and an earlier version of this file was wrong by 9x about Polygon. **[`GET /supported`](https://yen402.com/supported) is the source of truth.** It reports, per network, read live from the chain:

- `available` — whether we can settle there at all right now
- `sponsoredGas.settlementsAffordable` — how many settlements the wallet can still pay for
- `unavailableReason` — `not_offered`, or `insufficient_facilitator_gas` when we are out

If we cannot pay, we say so. We do not let you find out at the moment money moves.

Need more? Don't ask for a quota — **run your own**. The facilitator is MIT-licensed and deploys to Vercel in minutes (see *Self-hosting*). Set `MIN_SETTLE_JPYC=0` for sub-yen payments and `DAILY_SETTLE_BUDGET_<chainId>` for whatever your own wallet can bear.

## Why there is no API key

The key this facilitator used to require never protected funds. `authorization.to` sits inside the buyer's EIP-3009 signature, so a facilitator **cannot** redirect a payment — the worst it can do is refuse to broadcast one. The key only protected the facilitator's own sponsored gas, and it did so at the cost of making the service unusable by anyone who had not registered first.

Gas is bounded directly instead: a rate limit, a published daily budget, and a dust floor. That is also how every other facilitator in the [x402 directory](https://github.com/x402-foundation/x402/blob/main/docs/dev-tools/facilitators.md) does it (PayAI, Dexter, Mogami and HPP all require no API key).

The one check that makes an open facilitator safe is this: the recipient the buyer **signed** (`authorization.to`) must equal the recipient the seller **declared** (`paymentRequirements.payTo`). A mismatch is rejected before anything is broadcast.

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
  url: "https://yen402.com",
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
curl -X POST https://yen402.com/verify \
  -H "Content-Type: application/json" \
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
| `FACILITATOR_PRIVATE_KEY` | Yes | Wallet private key used to broadcast `transferWithAuthorization`. Must hold native gas on every chain you intend to settle on (MATIC / ETH / AVAX / KAIA). |
| `POLYGON_RPC_URL` | Yes | Polygon mainnet RPC endpoint (Alchemy / QuickNode recommended) |
| `AMOY_RPC_URL` | Optional | Polygon Amoy testnet RPC endpoint |
| `ETHEREUM_RPC_URL` | Optional | Ethereum mainnet RPC endpoint. Needed only to settle on `eip155:1`. |
| `AVALANCHE_RPC_URL` | Optional | Avalanche C-Chain RPC endpoint. Needed only to settle on `eip155:43114`. |
| `KAIA_RPC_URL` | Optional | Kaia mainnet RPC endpoint (`https://public-en.node.kaia.io` works). Needed only to settle on `eip155:8217`. |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST URL — nonce replay protection, rate limiting, gas budget |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST token |
| `RATE_LIMIT_RPS` | Optional | Requests/second per subject (default `4`) |
| `RATE_LIMIT_BURST_PER_MIN` | Optional | Requests/minute per subject (default `480`) |
| `DAILY_SETTLE_BUDGET_<chainId>` | Optional | Sponsored settlements per UTC day for one chain, e.g. `DAILY_SETTLE_BUDGET_137=5000`. Defaults are sized by that chain's gas cost. |
| `MIN_SETTLE_JPYC` | Optional | Dust floor in whole yen (default `1`; set `0` to allow sub-yen payments) |

No database. The settlement path touches the chain and Redis, nothing else.

## Self-hosting

The public instance is rate-limited and gas-budgeted because it is a shared, sponsored service. Your own instance is neither.

```bash
git clone https://github.com/kakedashi3/x402-jpyc && cd x402-jpyc
npm install
# set FACILITATOR_PRIVATE_KEY, POLYGON_RPC_URL, UPSTASH_REDIS_REST_URL/TOKEN
npx vercel --prod
```

Your facilitator wallet pays the gas for the settlements it broadcasts, so fund it with native gas on each chain you settle.

## Notes

- JPYC (JPY Coin) settlement uses EIP-3009 `transferWithAuthorization(...)`.
- The facilitator is the relayer; the payer signs an EIP-712 typed authorization off-chain.
- EIP-712 domain: `name: "JPY Coin"`, `version: "1"`. `chainId` comes from the payment's own `network` (`eip155:1`, `137`, `80002`, `43114`, `8217`) — not from any server-side binding.
- Supported chains: Ethereum (`1`), Polygon (`137`), Polygon Amoy (`80002`, testnet), Avalanche (`43114`), Kaia (`8217`). JPYC shares the proxy address `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29` and 18 decimals on every chain. See `spec.md` for the wire-level table.
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
