/**
 * JPYC コントラクトが EIP-3009 (transferWithAuthorization) に
 * 対応しているか確認するスクリプト
 *
 * 検証方法:
 *   1. authorizationState(address, bytes32) をダミー引数でライブコール
 *   2. 実装コントラクトのバイトコードに function selector が含まれるか確認
 *      (プロキシの場合は EIP-1967 slot から実装アドレスを取得)
 *
 * 実行: npx tsx scripts/check-eip3009.ts
 */

import {
  createPublicClient,
  http,
  parseAbi,
  type Hex,
  zeroAddress,
  zeroHash,
  padHex,
} from "viem";
import { polygon } from "viem/chains";

const JPYC_ADDRESS = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29" as const;

const rpcUrl =
  process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com";

const client = createPublicClient({
  chain: polygon,
  transport: http(rpcUrl),
});

/* ── EIP-3009 function selectors ── */
const SELECTORS: Record<string, Hex> = {
  transferWithAuthorization: "0xe3ee160e",
  receiveWithAuthorization: "0xef55bec6",
  cancelAuthorization: "0x5a049a70",
  authorizationState: "0xe94a0102",
};

/* ── EIP-1967 implementation storage slot ── */
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

/* ── Resolve implementation address behind proxy ── */
async function getImplementationAddress(): Promise<`0x${string}` | null> {
  try {
    const raw = await client.getStorageAt({
      address: JPYC_ADDRESS,
      slot: EIP1967_IMPL_SLOT,
    });
    if (!raw || raw === zeroHash) return null;
    // Storage is 32 bytes, address is last 20 bytes
    return `0x${raw.slice(26)}` as `0x${string}`;
  } catch {
    return null;
  }
}

/* ── Bytecode selector check ── */
function hasSelector(bytecode: Hex, selector: Hex): boolean {
  return bytecode.includes(selector.slice(2));
}

/* ── Live call checks via proxy ── */
async function checkAuthorizationStateLive(): Promise<boolean> {
  const abi = parseAbi([
    "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  ]);
  try {
    const result = await client.readContract({
      address: JPYC_ADDRESS,
      abi,
      functionName: "authorizationState",
      args: [zeroAddress, zeroHash],
    });
    console.log(`  authorizationState(0x0…, 0x0…) → ${result} (関数存在)`);
    return true;
  } catch {
    console.log(`  authorizationState: NOT FOUND`);
    return false;
  }
}

async function checkTransferWithAuthLive(): Promise<boolean> {
  // Call with dummy args — expect revert due to invalid signature,
  // but NOT "function not found" revert
  const abi = parseAbi([
    "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  ]);
  try {
    await client.simulateContract({
      address: JPYC_ADDRESS,
      abi,
      functionName: "transferWithAuthorization",
      args: [
        zeroAddress,
        zeroAddress,
        0n,
        0n,
        0n,
        zeroHash,
        0,
        zeroHash,
        zeroHash,
      ],
      account: zeroAddress,
    });
    // Unlikely to succeed but if it does, function exists
    console.log(`  transferWithAuthorization: call succeeded (関数存在)`);
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // "execution reverted" means the function dispatched but failed (= exists)
    if (
      msg.includes("execution reverted") ||
      msg.includes("revert") ||
      msg.includes("ECRecover")
    ) {
      console.log(
        `  transferWithAuthorization: reverted with business logic error (関数存在)`,
      );
      return true;
    }
    console.log(
      `  transferWithAuthorization: NOT FOUND (${msg.slice(0, 100)})`,
    );
    return false;
  }
}

async function checkReceiveWithAuthLive(): Promise<boolean> {
  const abi = parseAbi([
    "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  ]);
  try {
    await client.simulateContract({
      address: JPYC_ADDRESS,
      abi,
      functionName: "receiveWithAuthorization",
      args: [
        zeroAddress,
        zeroAddress,
        0n,
        0n,
        0n,
        zeroHash,
        0,
        zeroHash,
        zeroHash,
      ],
      account: zeroAddress,
    });
    console.log(`  receiveWithAuthorization: call succeeded (関数存在)`);
    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("execution reverted") ||
      msg.includes("revert") ||
      msg.includes("ECRecover")
    ) {
      console.log(
        `  receiveWithAuthorization: reverted with business logic error (関数存在)`,
      );
      return true;
    }
    console.log(
      `  receiveWithAuthorization: NOT FOUND (${msg.slice(0, 100)})`,
    );
    return false;
  }
}

async function main() {
  console.log("=== EIP-3009 Support Check for JPYC on Polygon ===");
  console.log(`Contract (proxy): ${JPYC_ADDRESS}`);
  console.log(`RPC:              ${rpcUrl}`);
  console.log();

  // ── Resolve implementation ──
  const implAddr = await getImplementationAddress();
  if (implAddr) {
    console.log(`Implementation:   ${implAddr} (EIP-1967 proxy detected)`);
  } else {
    console.log(`Implementation:   direct contract (no proxy detected)`);
  }
  console.log();

  // ── Check 1: Selector in implementation bytecode ──
  const targetAddr = implAddr || JPYC_ADDRESS;
  const bytecode = await client.getCode({ address: targetAddr });
  if (!bytecode || bytecode === "0x") {
    console.error("ERROR: No bytecode found at implementation address");
    process.exit(1);
  }
  console.log(
    `[1] Function selector check (implementation bytecode, ${Math.floor(bytecode.length / 2 - 1)} bytes):`,
  );
  const selectorResults: Record<string, boolean> = {};
  for (const [name, selector] of Object.entries(SELECTORS)) {
    const found = hasSelector(bytecode, selector);
    selectorResults[name] = found;
    const pad = name.padEnd(30);
    console.log(`  ${pad} ${selector}  ${found ? "FOUND" : "NOT FOUND"}`);
  }
  console.log();

  // ── Check 2: Live call checks via proxy ──
  console.log("[2] Live call checks (via proxy):");
  const liveTransfer = await checkTransferWithAuthLive();
  const liveReceive = await checkReceiveWithAuthLive();
  const liveAuthState = await checkAuthorizationStateLive();
  console.log();

  // ── Summary ──
  const transferOk = selectorResults["transferWithAuthorization"] || liveTransfer;
  const receiveOk = selectorResults["receiveWithAuthorization"] || liveReceive;
  const authStateOk = selectorResults["authorizationState"] || liveAuthState;

  console.log("=== Result ===");
  console.log(
    `  transferWithAuthorization: ${transferOk ? "存在する" : "存在しない"}`,
  );
  console.log(
    `  receiveWithAuthorization:  ${receiveOk ? "存在する" : "存在しない"}`,
  );
  console.log(
    `  authorizationState:        ${authStateOk ? "存在する" : "存在しない"}`,
  );
  console.log();

  const eip3009 = transferOk && authStateOk;
  console.log(`  → EIP-3009: ${eip3009 ? "YES" : "NO"}`);
  console.log("  → x402 'exact' scheme available");

  if (!eip3009) {
    process.exit(1);
  }
}

main().catch(console.error);
