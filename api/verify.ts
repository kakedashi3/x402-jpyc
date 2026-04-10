export const config = {
  runtime: "edge",
};

import {
  createWalletClient,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const PERMIT2_ADDRESS: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const JPYC_ADDRESS: Address = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";

const PERMIT2_ABI = [
  {
    name: "permitTransferFrom",
    type: "function",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        name: "transferDetails",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "requestedAmount", type: "uint256" },
        ],
      },
      { name: "owner", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// Module-level initialization
console.log("[verify] module load", Date.now());
console.log("[verify] PRIVATE_KEY exists:", !!process.env.FACILITATOR_PRIVATE_KEY);
console.log("[verify] RPC_URL exists:", !!process.env.POLYGON_RPC_URL);

const _privateKey = process.env.FACILITATOR_PRIVATE_KEY;
const _rpcUrl = process.env.POLYGON_RPC_URL;

const _key = _privateKey
  ? ((_privateKey.startsWith("0x") ? _privateKey : `0x${_privateKey}`) as Hex)
  : null;

console.log("[verify] privateKeyToAccount start", Date.now());
const _account = _key ? privateKeyToAccount(_key) : null;
if (_account) console.log("[verify] privateKeyToAccount done", _account.address, Date.now());

const walletClient =
  _account && _rpcUrl
    ? createWalletClient({ account: _account, chain: polygon, transport: http(_rpcUrl) })
    : null;

console.log("[verify] walletClient initialized:", !!walletClient);

interface PermitTransferFrom {
  permitted: {
    token: string;
    amount: string;
  };
  nonce: string;
  deadline: string;
}

interface TransferDetails {
  to: string;
  requestedAmount: string;
}

interface VerifyRequest {
  permit: PermitTransferFrom;
  transferDetails: TransferDetails;
  owner: string;
  signature: string;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export default async function handler(req: Request): Promise<Response> {
  console.log("[verify] start", Date.now());

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!walletClient) {
    return json({ error: "Service not configured" }, 503);
  }
  const client = walletClient;

  let body: VerifyRequest;
  try {
    body = (await req.json()) as VerifyRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { permit, transferDetails, owner, signature } = body;

  if (!permit || !transferDetails || !owner || !signature) {
    return json(
      {
        error:
          "Missing required fields: permit, transferDetails, owner, signature",
      },
      400
    );
  }

  // Validate JPYC token
  try {
    if (getAddress(permit.permitted.token) !== getAddress(JPYC_ADDRESS)) {
      return json(
        { error: `Unsupported token: expected JPYC (${JPYC_ADDRESS})` },
        400
      );
    }
  } catch {
    return json({ error: "Invalid permit.permitted.token address" }, 400);
  }

  // Validate deadline
  const deadline = BigInt(permit.deadline);
  if (deadline < BigInt(Math.floor(Date.now() / 1000))) {
    return json({ error: "Permit deadline has expired" }, 400);
  }

  try {
    console.log("[verify] before writeContract", Date.now());
    const txHash = await client.writeContract({
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ABI,
      functionName: "permitTransferFrom",
      args: [
        {
          permitted: {
            token: getAddress(permit.permitted.token),
            amount: BigInt(permit.permitted.amount),
          },
          nonce: BigInt(permit.nonce),
          deadline: BigInt(permit.deadline),
        },
        {
          to: getAddress(transferDetails.to),
          requestedAmount: BigInt(transferDetails.requestedAmount),
        },
        getAddress(owner) as Address,
        signature as Hex,
      ],
    });

    console.log("[verify] after writeContract", txHash, Date.now());
    return json({ isValid: true, txHash, status: "pending" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.log("[verify] writeContract error", message, Date.now());
    return json({ isValid: false, error: message }, 500);
  }
}
