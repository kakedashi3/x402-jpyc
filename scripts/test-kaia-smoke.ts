/**
 * Kaia mainnet smoke test for the yen402 facilitator.
 *
 * Signs an EIP-3009 transferWithAuthorization for JPYC on Kaia
 * (ChainID 8217), then walks the facilitator through /verify and
 * /settle to produce a real on-chain transfer.
 *
 * Required env:
 *   BUYER_PRIVATE_KEY     - 0x-prefixed buyer private key (holds JPYC on Kaia)
 *   PAY_TO                - recipient address (must be on api_key allowlist)
 *   FACILITATOR_API_KEY   - yen402 x-api-key bound to chain_id=8217 + PAY_TO
 *
 * Optional env:
 *   FACILITATOR_URL       - default https://x402-jpyc.vercel.app
 *   AMOUNT_JPYC           - JPYC integer string, default "1" (= 1 JPYC)
 *   KAIA_RPC_URL          - default https://public-en.node.kaia.io
 *
 * Run:
 *   npx tsx scripts/test-kaia-smoke.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Hex,
} from "viem";
import { kaia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { KAIA } from "../lib/chain-config.js";

const FACILITATOR_URL =
  process.env.FACILITATOR_URL?.replace(/\/$/, "") ??
  "https://x402-jpyc.vercel.app";
const KAIA_RPC =
  process.env.KAIA_RPC_URL ?? "https://public-en.node.kaia.io";
const AMOUNT_JPYC = process.env.AMOUNT_JPYC ?? "1";

const EIP712_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Error: ${name} is not set`);
    process.exit(1);
  }
  return v;
}

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")) as Hex;
}

async function main() {
  const buyerKey = requireEnv("BUYER_PRIVATE_KEY") as Hex;
  const payTo = requireEnv("PAY_TO") as Hex;
  const apiKey = requireEnv("FACILITATOR_API_KEY");

  const account = privateKeyToAccount(
    buyerKey.startsWith("0x") ? buyerKey : (`0x${buyerKey}` as Hex),
  );
  const buyer = account.address;

  const value = parseUnits(AMOUNT_JPYC, KAIA.jpycDecimals);
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 60 * 60); // +1h
  const nonce = randomNonce();

  console.log("─── Kaia mainnet smoke test ───");
  console.log(`Facilitator : ${FACILITATOR_URL}`);
  console.log(`Network     : eip155:8217 (Kaia mainnet)`);
  console.log(`JPYC        : ${KAIA.jpycAddress}`);
  console.log(`Buyer       : ${buyer}`);
  console.log(`PayTo       : ${payTo}`);
  console.log(`Amount      : ${AMOUNT_JPYC} JPYC (${value} wei)`);
  console.log(`Nonce       : ${nonce}`);
  console.log(`ValidBefore : ${validBefore} (unix sec)`);
  console.log();

  // ---- pre-flight: buyer balance ----
  const pub = createPublicClient({ chain: kaia, transport: http(KAIA_RPC) });
  const balance = (await pub.readContract({
    address: KAIA.jpycAddress,
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "a", type: "address" }],
        outputs: [{ type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [buyer],
  })) as bigint;
  console.log(
    `Buyer balance: ${balance} wei (${Number(balance) / 10 ** 18} JPYC)`,
  );
  if (balance < value) {
    console.error("Insufficient JPYC balance");
    process.exit(1);
  }

  // ---- sign EIP-3009 ----
  const domain = {
    name: KAIA.eip712Name,
    version: KAIA.eip712Version,
    chainId: KAIA.chainId,
    verifyingContract: KAIA.jpycAddress,
  } as const;

  const wallet = createWalletClient({
    account,
    chain: kaia,
    transport: http(KAIA_RPC),
  });

  const signature = (await wallet.signTypedData({
    domain,
    types: EIP712_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: buyer,
      to: payTo,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  })) as Hex;

  console.log(`Signature   : ${signature}`);
  console.log();

  // ---- build x402 v2 body ----
  const body = {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: "eip155:8217",
        asset: KAIA.jpycAddress,
        payTo,
      },
      payload: {
        signature,
        authorization: {
          from: buyer,
          to: payTo,
          value: value.toString(),
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
        },
      },
    },
    paymentRequirements: {
      scheme: "exact",
      network: "eip155:8217",
      asset: KAIA.jpycAddress,
      amount: value.toString(),
      payTo,
      extra: { name: KAIA.eip712Name, version: KAIA.eip712Version },
    },
  };

  // ---- /verify ----
  console.log("─── POST /verify ───");
  const vRes = await fetch(`${FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const vText = await vRes.text();
  console.log(`Status: ${vRes.status}`);
  console.log("Body  :", vText);
  console.log();

  if (!vRes.ok) {
    console.error("verify failed; aborting before /settle");
    process.exit(2);
  }

  // ---- /settle ----
  console.log("─── POST /settle ───");
  const sRes = await fetch(`${FACILITATOR_URL}/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const sText = await sRes.text();
  console.log(`Status: ${sRes.status}`);
  console.log("Body  :", sText);
  console.log();

  try {
    const parsed = JSON.parse(sText) as {
      success?: boolean;
      transaction?: string;
      txHash?: string;
    };
    const tx = parsed.transaction ?? parsed.txHash;
    if (parsed.success && tx) {
      console.log(`✅ Settled. Kaia explorer:`);
      console.log(`   https://kaiascan.io/tx/${tx}`);
    } else {
      console.log("❌ Settle did not succeed.");
      process.exit(3);
    }
  } catch {
    console.log("(non-JSON settle response, see body above)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
