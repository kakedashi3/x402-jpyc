import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { POLYGON, type ChainConfig } from "../../chain-config.js";

// Test-only private keys. NEVER use these on mainnet.
// Generated from arbitrary 32-byte patterns; published in this repo on purpose.
export const TEST_SIGNER_PRIVATE_KEY =
  "0x1010101010101010101010101010101010101010101010101010101010101010" as Hex;
export const WRONG_SIGNER_PRIVATE_KEY =
  "0x2020202020202020202020202020202020202020202020202020202020202020" as Hex;

export const testSigner: PrivateKeyAccount = privateKeyToAccount(
  TEST_SIGNER_PRIVATE_KEY,
);
export const wrongSigner: PrivateKeyAccount = privateKeyToAccount(
  WRONG_SIGNER_PRIVATE_KEY,
);

export interface AuthInput {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

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

export async function signAuthorization(
  signer: PrivateKeyAccount,
  auth: AuthInput,
  chain: ChainConfig = POLYGON,
): Promise<Hex> {
  return signer.signTypedData({
    domain: {
      name: chain.eip712Name,
      version: chain.eip712Version,
      chainId: chain.chainId,
      verifyingContract: chain.jpycAddress,
    },
    types: EIP712_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
  });
}

export const RECIPIENT_ADDRESS =
  "0x2222222222222222222222222222222222222222" as Address;
export const FACILITATOR_ADDRESS =
  "0x3333333333333333333333333333333333333333" as Address;
