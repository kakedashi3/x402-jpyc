import {
  type Address,
  type Hash,
  type Log,
  decodeEventLog,
  getAddress,
  isAddress,
  isHash,
  parseAbi,
} from "viem";
import { getPolygonClient, POLYGON_NETWORK } from "./polygon.js";
import { claimNonce } from "./replay.js";

export const JPYC_ADDRESS: Address =
  "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";

export const JPYC_DECIMALS = 18;

const ERC20_TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface TransferEvent {
  from: Address;
  to: Address;
  value: bigint;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    txHash: Hash;
    from: string;
    to: string;
    amount: string;
  };
}

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export interface VerifyRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

export interface VerifyResponse {
  isValid: boolean;
  txHash?: Hash;
  amount?: string;
  paidAt?: string;
  invalidReason?: string;
}

function invalid(reason: string, txHash?: Hash): VerifyResponse {
  return { isValid: false, invalidReason: reason, ...(txHash && { txHash }) };
}

function findJPYCTransfers(logs: Log[]): TransferEvent[] {
  const transfers: TransferEvent[] = [];

  for (const log of logs) {
    if (getAddress(log.address) !== getAddress(JPYC_ADDRESS)) continue;

    try {
      const decoded = decodeEventLog({
        abi: ERC20_TRANSFER_ABI,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName === "Transfer") {
        transfers.push({
          from: decoded.args.from,
          to: decoded.args.to,
          value: decoded.args.value,
        });
      }
    } catch {
      // Not a Transfer event from JPYC, skip
    }
  }

  return transfers;
}

export async function verifyJPYCPayment(
  req: VerifyRequest
): Promise<VerifyResponse> {
  const { paymentPayload, paymentRequirements } = req;

  // --- Input validation ---

  if (paymentPayload.scheme !== "evm-erc20-transfer") {
    return invalid(`unsupported scheme: ${paymentPayload.scheme}`);
  }

  if (paymentRequirements.scheme !== "evm-erc20-transfer") {
    return invalid(`unsupported requirements scheme: ${paymentRequirements.scheme}`);
  }

  if (paymentPayload.network !== POLYGON_NETWORK) {
    return invalid(
      `unsupported network: ${paymentPayload.network}, expected ${POLYGON_NETWORK}`
    );
  }

  if (!isHash(paymentPayload.payload.txHash)) {
    return invalid("invalid txHash format");
  }

  if (!isAddress(paymentPayload.payload.from)) {
    return invalid("invalid payload.from address");
  }

  if (!isAddress(paymentRequirements.payTo)) {
    return invalid("invalid paymentRequirements.payTo address");
  }

  let requiredAmount: bigint;
  try {
    requiredAmount = BigInt(paymentRequirements.amount);
    if (requiredAmount <= 0n) throw new Error();
  } catch {
    return invalid("invalid paymentRequirements.amount");
  }

  let assetAddress: Address;
  try {
    assetAddress = getAddress(paymentRequirements.asset);
  } catch {
    return invalid("invalid paymentRequirements.asset address");
  }

  if (assetAddress !== getAddress(JPYC_ADDRESS)) {
    return invalid(
      `unsupported asset: ${paymentRequirements.asset}, expected JPYC (${JPYC_ADDRESS})`
    );
  }

  const txHash = paymentPayload.payload.txHash;

  // --- Replay protection ---

  const claimed = await claimNonce({
    contractAddress: JPYC_ADDRESS,
    from: paymentPayload.payload.from as Address,
    nonce: txHash,
    validBefore: 0n,
  });
  if (!claimed) {
    return invalid("transaction already used (replay)", txHash);
  }

  // --- On-chain verification ---

  const client = getPolygonClient();

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch {
    return invalid("transaction not found or not yet confirmed", txHash);
  }

  if (receipt.status !== "success") {
    return invalid("transaction reverted", txHash);
  }

  const transfers = findJPYCTransfers(receipt.logs as Log[]);

  if (transfers.length === 0) {
    return invalid("no JPYC transfer event found in transaction", txHash);
  }

  const requiredFrom = getAddress(paymentPayload.payload.from as Address);
  const requiredTo = getAddress(paymentRequirements.payTo as Address);

  const matchingTransfer = transfers.find(
    (t) =>
      getAddress(t.from) === requiredFrom &&
      getAddress(t.to) === requiredTo &&
      t.value >= requiredAmount
  );

  if (!matchingTransfer) {
    return invalid(
      "no matching JPYC transfer with correct sender, recipient, and amount",
      txHash
    );
  }

  const block = await client.getBlock({
    blockNumber: receipt.blockNumber,
  });

  return {
    isValid: true,
    txHash,
    amount: matchingTransfer.value.toString(),
    paidAt: new Date(Number(block.timestamp) * 1000).toISOString(),
  };
}
