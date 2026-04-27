[![CI](https://github.com/kakedashi3/x402-jpyc/actions/workflows/ci.yml/badge.svg)](https://github.com/kakedashi3/x402-jpyc/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# x402-jpyc

Polygon 上の JPYC (JPY Coin) で動く x402 ファシリテーター。HTTP API が JPYC で課金でき、クライアントは EIP-3009 署名された認可で支払えます。

[English README](./README.md)

## エンドポイント

ホスト先: `https://x402-jpyc.vercel.app`。短い形式と `/api/*` 形式の両方が使えます（Vercel rewrites）。

| Method | Path | 用途 |
|---|---|---|
| `POST` | `/verify` | EIP-3009 認可データの検証 |
| `POST` | `/settle` | 検証後、`transferWithAuthorization` をオンチェーン送信 |
| `GET`  | `/health` | ヘルスチェック |
| `GET`  | `/payment-info` | API キーに紐づく受取アドレスを取得 |

## クイックスタート — サーバー側

x402 v2 ミドルウェアをインストール：

```bash
npm install @x402/express @x402/core @x402/evm viem
```

Express ルートで JPYC 支払いを受け付ける：

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
            amount: "1000000000000000000", // 1 JPYC（18 decimals）
            payTo: "0xYOUR_WALLET_ADDRESS",
            extra: {
              assetTransferMethod: "eip3009",
              name: "JPY Coin",
              version: "1",
            },
          },
        ],
        description: "有料データ",
        mimeType: "application/json",
      },
    },
    server,
  ),
);

app.get("/api/data", (req, res) => {
  res.json({ message: "有料コンテンツを配信しました" });
});

app.listen(3000);
```

## クイックスタート — クライアント側

viem で EIP-3009 認可に署名し、有料 API を呼び出す：

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
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1時間
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

## API リファレンス

### `POST /verify`

支払い認可を検証する。ブロードキャストはしない。

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

レスポンス：

```json
{ "isValid": true, "payer": "0xSENDER_ADDRESS" }
```

### `POST /settle`

検証したうえで Polygon 上に `transferWithAuthorization` を送信する。リクエストボディは `/verify` と同じ。

レスポンス：

```json
{ "success": true, "txHash": "0x...", "network": "eip155:137" }
```

### `GET /payment-info`

API キーに登録された受取アドレスを返す。

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

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `FACILITATOR_PRIVATE_KEY` | Yes | `transferWithAuthorization` をブロードキャストするウォレット秘密鍵 |
| `POLYGON_RPC_URL` | Yes | Polygon RPC エンドポイント（Alchemy / QuickNode 推奨） |
| `SUPABASE_URL` | Yes | Supabase プロジェクト URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase サービスロールキー（サーバーサイド専用） |
| `UPSTASH_REDIS_REST_URL` | Yes | nonce リプレイ保護用の Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST トークン |

## API キー管理

API キーは Supabase の `api_keys` テーブルで管理：

| カラム | 説明 |
|---|---|
| `api_key_hash` | 生キーの SHA-256 ハッシュ（生キーは保存しない） |
| `api_key_prefix` | 表示用のキー先頭数文字 |
| `recipient_address` | このキーで受け取る JPYC のオンチェーンアドレス |
| `is_active` | 削除せずに無効化できる |

リクエストごとに `x-api-key` ヘッダー値をハッシュ化して `api_key_hash` と照合する。送金先は API キーに登録された `recipient_address` が使われ、呼び出し元から指定できない。

## Notes

- JPYC (JPY Coin) の決済は EIP-3009 `transferWithAuthorization(...)` を使う。
- ファシリテーターはリレーヤーで、支払い者は EIP-712 typed data にオフチェーン署名する。
- EIP-712 ドメイン: `name: "JPY Coin"`, `version: "1"`, `chainId: 137`。
- nonce リプレイ保護は Upstash Redis での atomic な `SET NX + TTL`。キースコープは `chain:contract:from:nonce`、TTL は `validBefore` から算出。Redis 障害時は fail open し、オンチェーンの `authorizationState` チェックが最終防衛ラインとして機能し続ける。
- `/settle` はブロードキャスト直後に `txHash` を返す。
- ランタイム: Vercel Edge Functions。

## 決済例

[Polygonscan: 0x35c00930…3432b8c8f](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f)

| 項目 | 値 |
|---|---|
| tx ハッシュ | `0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f` |
| ブロック | 85338927 |
| ネットワーク | Polygon メインネット |

## ライセンス

MIT
