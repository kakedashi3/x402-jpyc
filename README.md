# x402 JPYC Facilitator

[x402 protocol](https://x402.org) facilitator for verifying JPYC payments on Polygon.

Built with TypeScript, [viem](https://viem.sh), and [Vercel Serverless Functions](https://vercel.com/docs/functions).

## What is this?

An x402 facilitator that resource servers can use to verify JPYC (JPY Coin) ERC-20 transfer payments on Polygon. When a client pays for a resource using JPYC, the resource server forwards the payment proof to this facilitator, which verifies the on-chain transaction and returns the result.

- **Token**: [JPYC](https://jpyc.jp) (`0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`)
- **Network**: Polygon PoS (`eip155:137`)
- **Scheme**: `evm-erc20-transfer`

## Why not the standard x402 `exact` scheme?

The x402 standard `exact` scheme relies on EIP-3009 (`transferWithAuthorization`), which enables gasless, signature-based token transfers. However, the JPYC contract on Polygon (`0xe7c3d8c9...`) **does not implement EIP-3009**. The following on-chain queries all revert:

- `TRANSFER_WITH_AUTHORIZATION_TYPEHASH` — revert
- `RECEIVE_WITH_AUTHORIZATION_TYPEHASH` — revert
- `CANCEL_AUTHORIZATION_TYPEHASH` — revert

Verified via `scripts/check-eip3009.ts` against Polygon RPC.

Therefore, this facilitator adopts the custom `evm-erc20-transfer` scheme, which verifies on-chain `Transfer` events from transaction receipts instead. This is the technical rationale for the x402-jpyc independent implementation.

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `POLYGON_RPC_URL` | **Yes** | Polygon RPC endpoint (e.g. Alchemy, Infura, QuickNode) |
| `API_KEY` | **Yes** | API key for authenticating requests. Service refuses all traffic if unset (fail-closed). Clients must send `X-API-Key` header. |

> **Note:** A reliable, dedicated RPC endpoint is strongly recommended for production.
> Public RPCs like `polygon-rpc.com` have strict rate limits and are not suitable for payment verification.

## API

### `POST /api/verify`

Verify a JPYC payment on Polygon.

```bash
curl -X POST http://localhost:3000/api/verify \
  -H "Content-Type: application/json" \
  -d '{
    "paymentPayload": {
      "x402Version": 2,
      "scheme": "evm-erc20-transfer",
      "network": "eip155:137",
      "payload": {
        "txHash": "0x...",
        "from": "0x...",
        "to": "0x...",
        "amount": "1000000000000000000"
      }
    },
    "paymentRequirements": {
      "scheme": "evm-erc20-transfer",
      "network": "eip155:137",
      "asset": "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
      "amount": "1000000000000000000",
      "payTo": "0x..."
    }
  }'
```

**Response (valid):**

```json
{
  "isValid": true,
  "txHash": "0x...",
  "amount": "1000000000000000000",
  "paidAt": "2025-01-15T10:30:00.000Z"
}
```

**Response (invalid):**

```json
{
  "isValid": false,
  "txHash": "0x...",
  "invalidReason": "no matching JPYC transfer to the required recipient with sufficient amount"
}
```

### `GET /api/health`

Health check endpoint.

## Deploy

```bash
npx vercel --prod
```

## Specification

See [spec.md](./spec.md) for the full protocol specification.

## License

MIT
