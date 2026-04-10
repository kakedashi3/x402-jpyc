# x402-jpyc

**The first working JPYC x402 facilitator.**

Enables AI agents and applications to pay for API access using JPYC (Japanese Yen stablecoin) on Polygon via the [x402 protocol](https://x402.org).

---

## Why x402-jpyc exists

| Problem | Detail |
|---|---|
| x402 is an open payment protocol by Coinbase | Supports ERC-20 payments for HTTP APIs |
| CDP facilitator does NOT support JPYC | Only USDC on Base is officially supported |
| JPYC does NOT implement EIP-3009 | `transferWithAuthorization` reverts on-chain |
| Therefore, a custom facilitator is required | x402-jpyc solves this |

Verified on-chain: `TRANSFER_WITH_AUTHORIZATION_TYPEHASH`, `RECEIVE_WITH_AUTHORIZATION_TYPEHASH`, and `CANCEL_AUTHORIZATION_TYPEHASH` all revert on the JPYC contract.

---

## Architecture

```
Client
  │
  │  POST /api/resource  (with X-PAYMENT header)
  ▼
Resource Server  (Express + x402 middleware)
  │
  │  POST /api/verify  (payment proof)
  ▼
x402-jpyc Facilitator  (this repo, Vercel Edge)
  │
  │  permitTransferFrom()
  ▼
Permit2 Contract  (0x000000000022D473030F116dDEE9F6B43aC78BA3)
  │
  ▼
Polygon Mainnet  →  JPYC transferred
```

---

## Facilitator Endpoint

```
POST https://x402-jpyc.vercel.app/api/verify
GET  https://x402-jpyc.vercel.app/api/health
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
      scheme: "exact",
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

Generate a Permit2 signature and call the paid API:

```typescript
import { createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const JPYC_ADDRESS = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";
const FACILITATOR_ADDRESS = "0xYOUR_FACILITATOR_WALLET";

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const client = createWalletClient({
  account,
  chain: polygon,
  transport: http("https://polygon-rpc.com"),
});

// 1. Sign Permit2 message
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour
const nonce = BigInt(Date.now());
const amount = parseUnits("1", 18); // 1 JPYC

const signature = await client.signTypedData({
  domain: {
    name: "Permit2",
    chainId: 137,
    verifyingContract: PERMIT2_ADDRESS,
  },
  types: {
    PermitTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  primaryType: "PermitTransferFrom",
  message: {
    permitted: { token: JPYC_ADDRESS, amount },
    spender: FACILITATOR_ADDRESS,
    nonce,
    deadline,
  },
});

// 2. Call paid API (x402 client sends this automatically)
const response = await fetch("https://your-server.com/api/data", {
  headers: {
    "X-PAYMENT": JSON.stringify({
      permit: {
        permitted: { token: JPYC_ADDRESS, amount: amount.toString() },
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      },
      transferDetails: {
        to: FACILITATOR_ADDRESS,
        requestedAmount: amount.toString(),
      },
      owner: account.address,
      signature,
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
| Transfer method | Permit2 (`permitTransferFrom`) |
| Permit2 contract | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| EIP-3009 support | Not supported by JPYC (verified on-chain) |
| CDP facilitator | Does not support JPYC (verified) |
| Runtime | Vercel Edge Functions |
| Response | Async — returns `txHash` immediately, status `"pending"` |

### API Request / Response

```bash
curl -X POST https://x402-jpyc.vercel.app/api/verify \
  -H "Content-Type: application/json" \
  -d '{
    "permit": {
      "permitted": {
        "token": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
        "amount": "1000000000000000000"
      },
      "nonce": "1234567890",
      "deadline": "1800000000"
    },
    "transferDetails": {
      "to": "0xFACILITATOR_ADDRESS",
      "requestedAmount": "1000000000000000000"
    },
    "owner": "0xCLIENT_ADDRESS",
    "signature": "0xSIGNATURE"
  }'
```

```json
{
  "isValid": true,
  "txHash": "0x...",
  "status": "pending"
}
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FACILITATOR_PRIVATE_KEY` | Yes | Wallet private key for signing Permit2 transactions |
| `POLYGON_RPC_URL` | Yes | Polygon RPC endpoint (Alchemy / QuickNode recommended) |

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
| JPYC は EIP-3009 を実装していない | `transferWithAuthorization` がオンチェーンでリバート |
| したがってカスタム実装が必要 | x402-jpyc がその実装 |

オンチェーン確認済み：JPYC コントラクト上で `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` 等がすべてリバートすることを確認。

---

## アーキテクチャ

```
クライアント
  │
  │  POST /api/resource（X-PAYMENT ヘッダー付き）
  ▼
リソースサーバー（Express + x402 ミドルウェア）
  │
  │  POST /api/verify（支払い証明）
  ▼
x402-jpyc ファシリテーター（このリポジトリ、Vercel Edge）
  │
  │  permitTransferFrom()
  ▼
Permit2 コントラクト（0x000000000022D473030F116dDEE9F6B43aC78BA3）
  │
  ▼
Polygon メインネット  →  JPYC 送金完了
```

---

## ファシリテーターエンドポイント

```
POST https://x402-jpyc.vercel.app/api/verify
GET  https://x402-jpyc.vercel.app/api/health
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
      scheme: "exact",
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

Permit2 署名を生成して有料 API を呼び出す例：

```typescript
import { createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const JPYC_ADDRESS = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";
const FACILITATOR_ADDRESS = "0xYOUR_FACILITATOR_WALLET";

const account = privateKeyToAccount("0xYOUR_PRIVATE_KEY");
const client = createWalletClient({
  account,
  chain: polygon,
  transport: http("https://polygon-rpc.com"),
});

// 1. Permit2 署名を生成
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const nonce = BigInt(Date.now());
const amount = parseUnits("1", 18); // 1 JPYC

const signature = await client.signTypedData({
  domain: {
    name: "Permit2",
    chainId: 137,
    verifyingContract: PERMIT2_ADDRESS,
  },
  types: {
    PermitTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  primaryType: "PermitTransferFrom",
  message: {
    permitted: { token: JPYC_ADDRESS, amount },
    spender: FACILITATOR_ADDRESS,
    nonce,
    deadline,
  },
});

// 2. 有料 API を呼び出す
const response = await fetch("https://your-server.com/api/data", {
  headers: {
    "X-PAYMENT": JSON.stringify({
      permit: {
        permitted: { token: JPYC_ADDRESS, amount: amount.toString() },
        nonce: nonce.toString(),
        deadline: deadline.toString(),
      },
      transferDetails: {
        to: FACILITATOR_ADDRESS,
        requestedAmount: amount.toString(),
      },
      owner: account.address,
      signature,
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
| 送金方式 | Permit2（`permitTransferFrom`） |
| Permit2 コントラクト | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| EIP-3009 対応 | JPYC は非対応（オンチェーン確認済み） |
| CDP ファシリテーター | JPYC 非対応（確認済み） |
| ランタイム | Vercel Edge Functions |
| レスポンス方式 | 非同期 — `txHash` を即座に返し、`status: "pending"` |

### リクエスト / レスポンス

```bash
curl -X POST https://x402-jpyc.vercel.app/api/verify \
  -H "Content-Type: application/json" \
  -d '{
    "permit": {
      "permitted": {
        "token": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
        "amount": "1000000000000000000"
      },
      "nonce": "1234567890",
      "deadline": "1800000000"
    },
    "transferDetails": {
      "to": "0xFACILITATOR_ADDRESS",
      "requestedAmount": "1000000000000000000"
    },
    "owner": "0xCLIENT_ADDRESS",
    "signature": "0xSIGNATURE"
  }'
```

```json
{
  "isValid": true,
  "txHash": "0x...",
  "status": "pending"
}
```

### 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| `FACILITATOR_PRIVATE_KEY` | Yes | Permit2 トランザクションに署名するウォレットの秘密鍵 |
| `POLYGON_RPC_URL` | Yes | Polygon RPC エンドポイント（Alchemy / QuickNode 推奨） |

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
