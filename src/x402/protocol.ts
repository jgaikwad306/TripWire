import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { authorizationTypes } from '@x402/evm';
import { getAddress, keccak256, toHex, type Hex } from 'viem';
import { z } from 'zod';
import { ARC_TESTNET, USDC_ADDRESS } from '../constants.js';
import type { Address, TypedDataRequest, Usdc } from '../types.js';

/**
 * The x402 protocol (v2) as this project speaks it: exact payments in USDC on Arc,
 * authorised with EIP-3009 `transferWithAuthorization`. Wire formats come from the
 * official @x402 packages, so any x402 client, server or facilitator can talk to ours.
 */
export type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse, VerifyResponse } from '@x402/core/types';

export const X402_VERSION = 2;
/** CAIP-2 id of Arc Testnet. */
export const ARC_NETWORK = `eip155:${ARC_TESTNET.chainId}` as const;
/** EIP-712 domain of USDC on Arc, read from the contract (name "USDC", version "2"). */
export const USDC_EIP712 = { name: 'USDC', version: '2' } as const;

/** HTTP headers of the x402 v2 transport. Each carries base64 JSON. */
export const HEADER = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
} as const;

/** How long a signed payment stays valid. Arc confirms in about a second. */
export const MAX_TIMEOUT_SECONDS = 120;

export const encode = {
  required: encodePaymentRequiredHeader,
  signature: encodePaymentSignatureHeader,
  response: encodePaymentResponseHeader,
};
export const decode = {
  required: decodePaymentRequiredHeader,
  signature: decodePaymentSignatureHeader,
  response: decodePaymentResponseHeader,
};

/** Requirements for an exact USDC payment on Arc. `asset` is overridable only to model counterfeits. */
export function exactRequirements(payTo: Address, amount: Usdc, asset: Address = USDC_ADDRESS): PaymentRequirements {
  return {
    scheme: 'exact',
    network: ARC_NETWORK,
    asset: getAddress(asset),
    amount: amount.toString(),
    payTo: getAddress(payTo),
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { ...USDC_EIP712, assetTransferMethod: 'eip3009' },
  };
}

/** The EIP-3009 authorization inside an exact payment. Every field is a string on the wire. */
export interface Eip3009Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

const hex = (bytes: number) => z.string().regex(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`));
const uint = z.string().regex(/^\d+$/);
const eip3009Schema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  authorization: z.object({
    from: hex(20),
    to: hex(20),
    value: uint,
    validAfter: uint,
    validBefore: uint,
    nonce: hex(32),
  }),
});

/** The signed EIP-3009 part of a payload, or undefined when the payload is not one. */
export function eip3009Of(payload: PaymentPayload): { signature: Hex; authorization: Eip3009Authorization } | undefined {
  const parsed = eip3009Schema.safeParse(payload?.payload);
  if (!parsed.success) return undefined;
  const a = parsed.data.authorization;
  return {
    signature: parsed.data.signature as Hex,
    authorization: {
      from: a.from.toLowerCase() as Address,
      to: a.to.toLowerCase() as Address,
      value: a.value,
      validAfter: a.validAfter,
      validBefore: a.validBefore,
      nonce: a.nonce.toLowerCase() as Hex,
    },
  };
}

/** Chain id from a CAIP-2 network such as "eip155:5042002". */
export function chainIdOf(network: string): number {
  const match = /^eip155:(\d+)$/.exec(network);
  if (!match) throw new Error(`Not an EVM network: ${network}`);
  return Number(match[1]);
}

/** The EIP-712 message an exact payment signs, exactly as the facilitator will rebuild it. */
export function authorizationTypedData(requirements: PaymentRequirements, authorization: Eip3009Authorization): TypedDataRequest {
  const name = requirements.extra?.name;
  const version = requirements.extra?.version;
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(`Payment requirements for ${requirements.asset} do not name the token's EIP-712 domain.`);
  }
  return {
    domain: { name, version, chainId: chainIdOf(requirements.network), verifyingContract: getAddress(requirements.asset) },
    types: { TransferWithAuthorization: [...authorizationTypes.TransferWithAuthorization] },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  };
}

/**
 * A nonce fixed by the payment's idempotency key. Signing again for the same payment
 * reproduces the same authorization, and the token contract settles a nonce only once,
 * so a retried payment can never be paid twice.
 */
export const nonceFor = (paymentKey: string): Hex => keccak256(toHex(`tripwire-payment:${paymentKey}`));

export type TypedDataSigner = (data: TypedDataRequest) => Promise<Hex>;

/** Builds and signs an exact payment for these requirements. */
export async function signPayment(args: {
  sign: TypedDataSigner;
  from: Address;
  requirements: PaymentRequirements;
  resource?: PaymentRequired['resource'];
  nonce: Hex;
  /** Unix seconds after which the authorization is void. */
  validBefore: number;
  /** Signed value; defaults to the required amount. Only attackers sign anything else. */
  value?: Usdc;
}): Promise<PaymentPayload> {
  const authorization: Eip3009Authorization = {
    from: getAddress(args.from) as Address,
    to: getAddress(args.requirements.payTo) as Address,
    value: (args.value ?? BigInt(args.requirements.amount)).toString(),
    validAfter: '0',
    validBefore: String(args.validBefore),
    nonce: args.nonce,
  };
  const signature = await args.sign(authorizationTypedData(args.requirements, authorization));
  return {
    x402Version: X402_VERSION,
    ...(args.resource ? { resource: args.resource } : {}),
    accepted: args.requirements,
    payload: { signature, authorization },
  };
}

/** The first option in a 402 that we can pay: exact, USDC, on Arc. */
export function pickRequirements(required: PaymentRequired): PaymentRequirements | undefined {
  return required.accepts.find(
    (r) =>
      r.scheme === 'exact' &&
      r.network === ARC_NETWORK &&
      typeof r.asset === 'string' &&
      r.asset.toLowerCase() === USDC_ADDRESS.toLowerCase(),
  );
}

/** Do two sets of requirements ask for the same payment? */
export function sameRequirements(a: PaymentRequirements, b: PaymentRequirements): boolean {
  return (
    a.scheme === b.scheme &&
    a.network === b.network &&
    a.asset.toLowerCase() === b.asset.toLowerCase() &&
    a.amount === b.amount &&
    a.payTo.toLowerCase() === b.payTo.toLowerCase()
  );
}
