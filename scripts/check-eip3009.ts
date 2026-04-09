/**
 * JPYC コントラクトが EIP-3009 (transferWithAuthorization) に
 * 対応しているか確認するスクリプト
 *
 * 確認方法:
 *   TRANSFER_WITH_AUTHORIZATION_TYPEHASH を public getter で読み取る
 *   存在すれば EIP-3009 対応、revert すれば非対応
 *
 * 実行: npx tsx scripts/check-eip3009.ts
 */

import { createPublicClient, http, parseAbi, type Address } from "viem";
import { polygon } from "viem/chains";
import { JPYC_ADDRESS } from "../lib/jpyc.js";

const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";

const client = createPublicClient({
  chain: polygon,
  transport: http(rpcUrl),
});

const eip3009Abi = parseAbi([
  "function TRANSFER_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
  "function CANCEL_AUTHORIZATION_TYPEHASH() view returns (bytes32)",
]);

type EIP3009Function =
  | "TRANSFER_WITH_AUTHORIZATION_TYPEHASH"
  | "RECEIVE_WITH_AUTHORIZATION_TYPEHASH"
  | "CANCEL_AUTHORIZATION_TYPEHASH";

async function checkTypehash(name: EIP3009Function) {
  try {
    const result = await client.readContract({
      address: JPYC_ADDRESS,
      abi: eip3009Abi,
      functionName: name,
    });
    console.log(`  ${name}: ${result}`);
    return true;
  } catch {
    console.log(`  ${name}: NOT FOUND (revert)`);
    return false;
  }
}

async function main() {
  console.log(`Checking EIP-3009 support for JPYC on Polygon`);
  console.log(`Contract: ${JPYC_ADDRESS}`);
  console.log(`RPC:      ${rpcUrl}`);
  console.log();

  console.log("Typehash queries:");
  const transferAuth = await checkTypehash("TRANSFER_WITH_AUTHORIZATION_TYPEHASH");
  await checkTypehash("RECEIVE_WITH_AUTHORIZATION_TYPEHASH");
  await checkTypehash("CANCEL_AUTHORIZATION_TYPEHASH");

  console.log();
  if (transferAuth) {
    console.log("Result: JPYC supports EIP-3009 (transferWithAuthorization)");
    console.log("  -> x402 'exact' scheme can be used");
  } else {
    console.log("Result: JPYC does NOT support EIP-3009");
    console.log("  -> x402 'exact' scheme cannot be used");
    console.log("  -> Use 'evm-erc20-transfer' scheme (Transfer event verification) instead");
  }
}

main().catch(console.error);
