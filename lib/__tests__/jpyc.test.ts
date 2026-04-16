import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock polygon client before importing jpyc
vi.mock("../polygon.js", () => ({
  POLYGON_NETWORK: "eip155:137",
  getPolygonClient: vi.fn(),
}));

// Mock replay store
vi.mock("../replay.js", () => ({
  claimNonce: vi.fn().mockResolvedValue(true),
}));

import { verifyJPYCPayment, type VerifyRequest, JPYC_ADDRESS } from "../jpyc.js";
import { getPolygonClient } from "../polygon.js";
import { claimNonce } from "../replay.js";
import { encodeEventTopics, encodeAbiParameters, parseAbi, type Hash } from "viem";

const VALID_FROM = "0x1111111111111111111111111111111111111111";
const VALID_TO = "0x2222222222222222222222222222222222222222";
const VALID_TX_HASH: Hash =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_AMOUNT = "1000000000000000000";

const transferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

function makeTransferLog(from: string, to: string, value: bigint) {
  const topics = encodeEventTopics({
    abi: transferAbi,
    eventName: "Transfer",
    args: { from: from as `0x${string}`, to: to as `0x${string}` },
  });
  const data = encodeAbiParameters(
    [{ type: "uint256" }],
    [value]
  );
  return {
    address: JPYC_ADDRESS,
    topics,
    data,
    blockNumber: 100n,
    transactionHash: VALID_TX_HASH,
    logIndex: 0,
    blockHash: "0x" + "bb".repeat(32),
    transactionIndex: 0,
    removed: false,
  };
}

function makeRequest(overrides?: {
  scheme?: string;
  reqScheme?: string;
  network?: string;
  txHash?: string;
  from?: string;
  payTo?: string;
  amount?: string;
  asset?: string;
}): VerifyRequest {
  return {
    paymentPayload: {
      x402Version: 2,
      scheme: overrides?.scheme ?? "evm-erc20-transfer",
      network: overrides?.network ?? "eip155:137",
      payload: {
        txHash: (overrides?.txHash ?? VALID_TX_HASH) as Hash,
        from: overrides?.from ?? VALID_FROM,
        to: VALID_TO,
        amount: VALID_AMOUNT,
      },
    },
    paymentRequirements: {
      scheme: overrides?.reqScheme ?? "evm-erc20-transfer",
      network: "eip155:137",
      asset: overrides?.asset ?? JPYC_ADDRESS,
      amount: overrides?.amount ?? VALID_AMOUNT,
      payTo: overrides?.payTo ?? VALID_TO,
    },
  };
}

function mockClient(receipt: unknown, block?: unknown) {
  const client = {
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    getBlock: vi.fn().mockResolvedValue(block ?? { timestamp: 1700000000n }),
  };
  vi.mocked(getPolygonClient).mockReturnValue(client as any);
  return client;
}

describe("verifyJPYCPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimNonce).mockResolvedValue(true);
  });

  it("returns valid for a correct transfer", async () => {
    mockClient({
      status: "success",
      blockNumber: 100n,
      logs: [makeTransferLog(VALID_FROM, VALID_TO, BigInt(VALID_AMOUNT))],
    });

    const result = await verifyJPYCPayment(makeRequest());
    expect(result.isValid).toBe(true);
    expect(result.txHash).toBe(VALID_TX_HASH);
    expect(result.amount).toBe(VALID_AMOUNT);
    expect(result.paidAt).toBeDefined();
  });

  it("rejects unsupported payload scheme", async () => {
    const result = await verifyJPYCPayment(makeRequest({ scheme: "exact" }));
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("unsupported scheme");
  });

  it("rejects mismatched requirements scheme", async () => {
    const result = await verifyJPYCPayment(
      makeRequest({ reqScheme: "exact" })
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("unsupported requirements scheme");
  });

  it("rejects unsupported network", async () => {
    const result = await verifyJPYCPayment(
      makeRequest({ network: "eip155:1" })
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("unsupported network");
  });

  it("rejects invalid from address", async () => {
    const result = await verifyJPYCPayment(makeRequest({ from: "not-an-address" }));
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("invalid payload.from address");
  });

  it("rejects invalid payTo address", async () => {
    const result = await verifyJPYCPayment(
      makeRequest({ payTo: "0xinvalid" })
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("invalid paymentRequirements.payTo");
  });

  it("rejects invalid amount", async () => {
    const result = await verifyJPYCPayment(makeRequest({ amount: "abc" }));
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("invalid paymentRequirements.amount");
  });

  it("rejects zero amount", async () => {
    const result = await verifyJPYCPayment(makeRequest({ amount: "0" }));
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("invalid paymentRequirements.amount");
  });

  it("rejects wrong asset", async () => {
    const result = await verifyJPYCPayment(
      makeRequest({ asset: "0x0000000000000000000000000000000000000001" })
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("unsupported asset");
  });

  it("rejects replay (same txHash used twice)", async () => {
    vi.mocked(claimNonce).mockResolvedValue(false);

    const result = await verifyJPYCPayment(makeRequest());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("replay");
  });

  it("rejects reverted transaction", async () => {
    mockClient({ status: "reverted", blockNumber: 100n, logs: [] });

    const result = await verifyJPYCPayment(makeRequest());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("reverted");
  });

  it("rejects transaction not found", async () => {
    const client = {
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error("not found")),
      getBlock: vi.fn(),
    };
    vi.mocked(getPolygonClient).mockReturnValue(client as any);

    const result = await verifyJPYCPayment(makeRequest());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("not found");
  });

  it("rejects insufficient amount", async () => {
    mockClient({
      status: "success",
      blockNumber: 100n,
      logs: [makeTransferLog(VALID_FROM, VALID_TO, 500n)],
    });

    const result = await verifyJPYCPayment(
      makeRequest({ amount: "1000" })
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("no matching JPYC transfer");
  });

  it("rejects sender mismatch", async () => {
    const wrongSender = "0x3333333333333333333333333333333333333333";
    mockClient({
      status: "success",
      blockNumber: 100n,
      logs: [makeTransferLog(wrongSender, VALID_TO, BigInt(VALID_AMOUNT))],
    });

    const result = await verifyJPYCPayment(makeRequest());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("no matching JPYC transfer");
  });

  it("rejects transaction with no JPYC transfer events", async () => {
    mockClient({
      status: "success",
      blockNumber: 100n,
      logs: [],
    });

    const result = await verifyJPYCPayment(makeRequest());
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toContain("no JPYC transfer event");
  });

  it("claims nonce after successful verification", async () => {
    mockClient({
      status: "success",
      blockNumber: 100n,
      logs: [makeTransferLog(VALID_FROM, VALID_TO, BigInt(VALID_AMOUNT))],
    });

    await verifyJPYCPayment(makeRequest());
    expect(claimNonce).toHaveBeenCalledWith({
      contractAddress: JPYC_ADDRESS,
      from: VALID_FROM,
      nonce: VALID_TX_HASH,
      validBefore: 0n,
    });
  });
});
