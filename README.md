# x402-jpyc

**The first working JPYC x402 facilitator.**

Enables AI agents and applications to pay for API access using JPYC (Japanese Yen stablecoin) on Polygon via the [x402 protocol](https://x402.org).

---

## Why x402-jpyc exists

| Problem | Detail |
|---|---|
| x402 is an open payment protocol by Coinbase | Supports ERC-20 payments for HTTP APIs |
| CDP facilitator does NOT support JPYC | Only USDC on Base is officially supported |
| JPYC supports EIP-3009 | `transferWithAuthorization` is available on the implementation contract |
| Therefore, a custom facilitator is required | x402-jpyc solves this using EIP-3009 |

Verified on-chain: JPYC implementation contract (`0xafac17fc3936a29ca2d2787ced3c5d1c52007d2e`) contains `transferWithAuthorization`, `receiveWithAuthorization`, `cancelAuthorization`, and `authorizationState`.

---

## Architecture

```
Client
  │
  │  POST /api/resource  (with X-PAYMENT header)
  ▼
Resource Server  (Express + x402 middleware)
  │
  │  POST /api/verify  (EIP-3009 authorization)
  ▼
x402-jpyc Facilitator  (this repo, Vercel Edge)
  │
  │  authorizationState()  — nonce replay check
  │  transferWithAuthorization(from, to, value, ..., v, r, s)
  ▼
JPYC Contract  (0xe7c3d8c9a439fede00d2600032d5db0be71c3c29)
  │
  ▼
Polygon Mainnet  →  JPYC transferred
```

---

## Facilitator Endpoints

```
POST https://x402-jpyc.vercel.app/api/verify   — validate payment authorization
POST https://x402-jpyc.vercel.app/api/settle   — execute on-chain transfer
GET  https://x402-jpyc.vercel.app/api/health   — health check
```

---

## Quick Start — Server Side

Install the x402 middleware:

```bash
npm install x402-express viem
```

Set up an Express server that accepts JPYC payments:

```typescript
import express from "express";
import { paymentMiddleware } from "x402-express";

const app = express();

app.use(
  paymentMiddleware({
    facilitatorUrl: "https://x402-jpyc.vercel.app",
    paymentRequirements: {
      scheme: "eip3009",
      network: "eip155:137",
      asset: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", // JPYC
      amount: "1000000000000000000", // 1 JPYC (18 decimals)
      payTo: "0xYOUR_WALLET_ADDRESS",
    },
  })
);

app.get("/api/data", (req, res) => {
  res.json({ message: "Paid content delivered" });
});

app.listen(3000);
```

---

## Quick Start — Client Side

Generate an EIP-3009 (EIP-712) signature and call the paid API:

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

// 1. Build EIP-3009 authorization
const amount = parseUnits("1", 18); // 1 JPYC
const validAfter = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour
const nonce = toHex(crypto.getRandomValues(new Uint8Array(32))); // random bytes32

// 2. Sign EIP-712 typed data (TransferWithAuthorization)
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

// 3. Call paid API (x402 client sends this automatically)
const response = await fetch("https://your-server.com/api/data", {
  headers: {
    "X-PAYMENT": JSON.stringify({
      paymentPayload: {
        x402Version: 1,
        scheme: "eip3009",
        network: "eip155:137",
        payload: {
          authorization: {
            from: account.address,
            to: PAY_TO,
            value: amount.toString(),
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
            nonce,
            signature,
          },
        },
      },
      paymentRequirements: {
        scheme: "eip3009",
        network: "eip155:137",
        asset: JPYC_ADDRESS,
        amount: amount.toString(),
        payTo: PAY_TO,
      },
    }),
  },
});

console.log(await response.json());
```

---

## Technical Details

| Item | Value |
|---|---|
| Network | Polygon PoS (`eip155:137`) |
| Asset | JPYC (`0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`) |
| Transfer method | EIP-3009 (`transferWithAuthorization`) |
| EIP-712 domain | `name: "JPY Coin"`, `version: "1"`, `chainId: 137` |
| Nonce replay check | `authorizationState(address, bytes32)` |
| CDP facilitator | Does not support JPYC (verified) |
| Runtime | Vercel Edge Functions |
| Response | Returns `txHash` immediately after broadcast |

### API Request / Response

```bash
curl -X POST https://x402-jpyc.vercel.app/api/verify \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "paymentPayload": {
      "x402Version": 1,
      "scheme": "eip3009",
      "network": "eip155:137",
      "payload": {
        "authorization": {
          "from": "0xSENDER_ADDRESS",
          "to": "0xRECIPIENT_ADDRESS",
          "value": "1000000000000000000",
          "validAfter": "0",
          "validBefore": "1800000000",
          "nonce": "0xRANDOM_BYTES32",
          "signature": "0xEIP712_SIGNATURE"
        }
      }
    },
    "paymentRequirements": {
      "scheme": "eip3009",
      "network": "eip155:137",
      "asset": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
      "amount": "1000000000000000000",
      "payTo": "0xRECIPIENT_ADDRESS"
    }
  }'
```

```json
{
  "isValid": true
}
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FACILITATOR_PRIVATE_KEY` | Yes | Wallet private key for broadcasting `transferWithAuthorization` |
| `POLYGON_RPC_URL` | Yes | Polygon RPC endpoint (Alchemy / QuickNode recommended) |
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-side only, never expose to clients) |

### API Key Management

API keys are managed via a Supabase `api_keys` table. Each key stores:

| Column | Description |
|---|---|
| `api_key_hash` | SHA-256 hash of the raw API key (raw key is never stored) |
| `api_key_prefix` | First few chars of the key for display/identification |
| `recipient_address` | On-chain address that receives JPYC payments for this key |
| `is_active` | Revoke a key without deleting it |

The `X-API-KEY` header value is hashed on each request and matched against `api_key_hash`. The `recipient_address` registered in the database is used as the transfer destination — the caller cannot override it.

---

## Changelog

### 2026-04-14 — Supabase-based API key authentication

**Breaking changes:**

- `API_KEY` environment variable removed. Replace with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- `POST /api/verify` no longer returns `txHash`. Response is now `{ "isValid": true }`.
- `recipient_address` is now taken from the `api_keys` table in Supabase. Callers can no longer set an arbitrary `payTo` address — it must match the address registered for the API key.

**New behavior:**

- Each API key is associated with a `recipient_address` in the database. The facilitator enforces that `authorization.to` matches this address.
- Successful requests are logged to `api_key_usage` (`event: verify_success` / `settle_success`).
- `last_used_at` is updated on every authenticated request.

---

## Proof of First Transaction

The first successful JPYC transfer via this facilitator:

| Field | Value |
|---|---|
| tx hash | `0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f` |
| Block | 85338927 |
| Network | Polygon mainnet |

[View on Polygonscan](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f)

---

## License

MIT

---
---

# x402-jpyc（日本語）

**世界初の動作する JPYC x402 ファシリテーター。**

[x402 プロトコル](https://x402.org)を使い、AI エージェントやアプリケーションが Polygon 上の JPYC（日本円ステーブルコイン）で API アクセスの料金を支払えるようにします。

---

## これは何か

HTTP API に対して JPYC で支払いを受け付けるためのファシリテーターです。

x402 プロトコルは Coinbase が策定したオープンな HTTP 課金プロトコルで、`402 Payment Required` ステータスコードを使ってクライアントに支払いを要求します。このリポジトリはその JPYC 対応実装です。

---

## なぜ作ったか

| 問題 | 詳細 |
|---|---|
| x402 は Coinbase のオープン課金プロトコル | HTTP API への ERC-20 支払いをサポート |
| CDP ファシリテーターは JPYC 非対応 | Base 上の USDC のみ公式サポート |
| JPYC は EIP-3009 対応 | 実装コントラクトに `transferWithAuthorization` が存在 |
| したがってカスタム実装が必要 | x402-jpyc が EIP-3009 を使って実装 |

オンチェーン確認済み：JPYC 実装コントラクト（`0xafac17fc3936a29ca2d2787ced3c5d1c52007d2e`）に `transferWithAuthorization`、`authorizationState` 等が存在することを確認。

---

## アーキテクチャ

```
クライアント
  │
  │  POST /api/resource（X-PAYMENT ヘッダー付き）
  ▼
リソースサーバー（Express + x402 ミドルウェア）
  │
  │  POST /api/verify（EIP-3009 認可データ）
  ▼
x402-jpyc ファシリテーター（このリポジトリ、Vercel Edge）
  │
  │  authorizationState()  — nonce 二重使用チェック
  │  transferWithAuthorization(from, to, value, ..., v, r, s)
  ▼
JPYC コントラクト（0xe7c3d8c9a439fede00d2600032d5db0be71c3c29）
  │
  ▼
Polygon メインネット  →  JPYC 送金完了
```

---

## ファシリテーターエンドポイント

```
POST https://x402-jpyc.vercel.app/api/verify   — 支払い認可の検証
POST https://x402-jpyc.vercel.app/api/settle   — オンチェーン送金の実行
GET  https://x402-jpyc.vercel.app/api/health   — ヘルスチェック
```

---

## クイックスタート（サーバー側）

JPYC で課金するサーバーの実装例：

```typescript
import express from "express";
import { paymentMiddleware } from "x402-express";

const app = express();

app.use(
  paymentMiddleware({
    facilitatorUrl: "https://x402-jpyc.vercel.app",
    paymentRequirements: {
      scheme: "eip3009",
      network: "eip155:137",
      asset: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29", // JPYC
      amount: "1000000000000000000", // 1 JPYC（18 decimals）
      payTo: "0xYOUR_WALLET_ADDRESS",
    },
  })
);

app.get("/api/data", (req, res) => {
  res.json({ message: "有料コンテンツを配信しました" });
});

app.listen(3000);
```

---

## クイックスタート（クライアント側）

EIP-3009（EIP-712）署名を生成して有料 API を呼び出す例：

```typescript
import { createWalletClient, http, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const JPYC_ADDRESS = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";
const PAY_TO = "0x受取先ウォレットアドレス";

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const client = createWalletClient({
  account,
  chain: polygon,
  transport: http("https://polygon-bor-rpc.publicnode.com"),
});

// 1. EIP-3009 認可データを構築
const amount = parseUnits("1", 18); // 1 JPYC
const validAfter = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1時間
const nonce = toHex(crypto.getRandomValues(new Uint8Array(32))); // ランダム bytes32

// 2. EIP-712 署名（TransferWithAuthorization）
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

// 3. 有料 API を呼び出す（x402 クライアントが自動的に送信）
const response = await fetch("https://your-server.com/api/data", {
  headers: {
    "X-PAYMENT": JSON.stringify({
      paymentPayload: {
        x402Version: 1,
        scheme: "eip3009",
        network: "eip155:137",
        payload: {
          authorization: {
            from: account.address,
            to: PAY_TO,
            value: amount.toString(),
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
            nonce,
            signature,
          },
        },
      },
      paymentRequirements: {
        scheme: "eip3009",
        network: "eip155:137",
        asset: JPYC_ADDRESS,
        amount: amount.toString(),
        payTo: PAY_TO,
      },
    }),
  },
});

console.log(await response.json());
```

---

## 技術詳細

| 項目 | 値 |
|---|---|
| ネットワーク | Polygon PoS（`eip155:137`） |
| トークン | JPYC（`0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`） |
| 送金方式 | EIP-3009（`transferWithAuthorization`） |
| EIP-712 ドメイン | `name: "JPY Coin"`, `version: "1"`, `chainId: 137` |
| Nonce 二重使用チェック | `authorizationState(address, bytes32)` |
| CDP ファシリテーター | JPYC 非対応（確認済み） |
| ランタイム | Vercel Edge Functions |
| レスポンス方式 | ブロードキャスト後 `txHash` を即座に返却 |

### リクエスト / レスポンス

```bash
curl -X POST https://x402-jpyc.vercel.app/api/verify \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "paymentPayload": {
      "x402Version": 1,
      "scheme": "eip3009",
      "network": "eip155:137",
      "payload": {
        "authorization": {
          "from": "0x送信元アドレス",
          "to": "0x受取先アドレス",
          "value": "1000000000000000000",
          "validAfter": "0",
          "validBefore": "1800000000",
          "nonce": "0xランダムBYTES32",
          "signature": "0xEIP712署名"
        }
      }
    },
    "paymentRequirements": {
      "scheme": "eip3009",
      "network": "eip155:137",
      "asset": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
      "amount": "1000000000000000000",
      "payTo": "0x受取先アドレス"
    }
  }'
```

```json
{
  "isValid": true
}
```

### 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| `FACILITATOR_PRIVATE_KEY` | Yes | `transferWithAuthorization` をブロードキャストするウォレットの秘密鍵 |
| `POLYGON_RPC_URL` | Yes | Polygon RPC エンドポイント（Alchemy / QuickNode 推奨） |
| `SUPABASE_URL` | Yes | Supabase プロジェクト URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase サービスロールキー（サーバーサイド専用。クライアントに公開しないこと） |

### API キーの管理

API キーは Supabase の `api_keys` テーブルで管理します。

| カラム | 説明 |
|---|---|
| `api_key_hash` | 生のキーを SHA-256 ハッシュ化した値（生キーは保存しない） |
| `api_key_prefix` | 表示・識別用のキー先頭数文字 |
| `recipient_address` | このキーに紐づく JPYC の受取アドレス |
| `is_active` | キーを削除せずに無効化できる |

リクエストごとに `X-API-KEY` ヘッダーの値をハッシュ化して `api_key_hash` と照合します。送金先は DB に登録された `recipient_address` が使われ、呼び出し元が任意のアドレスを指定することはできません。

---

## 更新履歴

### 2026-04-14 — Supabase による API キー認証に移行

**破壊的変更：**

- 環境変数 `API_KEY` を廃止。`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` に置き換えてください。
- `POST /api/verify` のレスポンスから `txHash` を削除。レスポンスは `{ "isValid": true }` のみになりました。
- 送金先アドレスは `api_keys` テーブルの `recipient_address` から取得するようになりました。呼び出し元が `payTo` を自由に指定することはできなくなりました。

**新しい動作：**

- API キーごとに `recipient_address` を DB で管理。`authorization.to` がこのアドレスと一致しない場合はエラーを返します。
- 認証成功後に `api_key_usage` テーブルへログを記録（`event: verify_success` / `settle_success`）。
- 認証リクエストのたびに `last_used_at` を更新します。

---

## 最初の取引の証明

このファシリテーター経由で初めて成功した JPYC 送金：

| 項目 | 値 |
|---|---|
| tx ハッシュ | `0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f` |
| ブロック | 85338927 |
| ネットワーク | Polygon メインネット |

[Polygonscan で確認](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f)

---

## ライセンス

MIT
