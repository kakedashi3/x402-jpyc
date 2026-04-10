/**
 * CDP facilitator verify endpoint smoke test for JPYC on Polygon.
 *
 * Required env vars:
 *   CDP_API_KEY_ID      - CDP API key ID
 *   CDP_API_KEY_SECRET  - CDP API key secret (PEM EC or base64 Ed25519)
 *
 * Run:
 *   npx tsx scripts/test-cdp-verify.ts
 */

import { generateJwt } from "@coinbase/cdp-sdk/auth";

const HOST = "api.cdp.coinbase.com";
const PATH = "/platform/v2/x402/verify";
const URL = `https://${HOST}${PATH}`;

const BODY = {
  x402Version: 2,
  paymentPayload: {
    x402Version: 2,
    // V2 schema: accepted holds the payment terms the client agreed to
    accepted: {
      scheme: "exact",
      network: "eip155:137",
      asset: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
      amount: "1000000000000000000",
      payTo: "0x0000000000000000000000000000000000000002",
      maxTimeoutSeconds: 60,
    },
    payload: {
      signature:
        "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        value: "1000000000000000000",
        validAfter: "0",
        validBefore: "99999999999",
        nonce:
          "0x0000000000000000000000000000000000000000000000000000000000000001",
      },
    },
  },
  paymentRequirements: {
    scheme: "exact",
    network: "eip155:137",
    asset: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
    amount: "1000000000000000000",
    payTo: "0x0000000000000000000000000000000000000002",
    maxTimeoutSeconds: 60,
    extra: {
      name: "JPY Coin",
      version: "1",
    },
  },
};

async function main() {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;

  if (!apiKeyId) {
    console.error("Error: CDP_API_KEY_ID is not set");
    process.exit(1);
  }
  if (!apiKeySecret) {
    console.error("Error: CDP_API_KEY_SECRET is not set");
    process.exit(1);
  }

  console.log(`Key ID : ${apiKeyId}`);
  console.log(`Target : POST ${URL}`);
  console.log(`Asset  : ${BODY.paymentRequirements.asset} (JPYC on Polygon)\n`);

  const jwt = await generateJwt({
    apiKeyId,
    apiKeySecret,
    requestMethod: "POST",
    requestHost: HOST,
    requestPath: PATH,
  });

  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(BODY),
  });

  const text = await res.text();

  console.log(`Status : ${res.status} ${res.statusText}`);
  console.log("Body   :");

  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
