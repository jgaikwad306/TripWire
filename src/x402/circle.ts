import { randomBytes } from 'node:crypto';
import { keccak256, toBytes, toHex, type Hex } from 'viem';
import type { Address, TypedDataRequest } from '../types.js';
import type { Facilitator } from './facilitator.js';
import { X402_VERSION, chainIdOf, type PaymentPayload, type PaymentRequirements, type SettleResponse, type VerifyResponse } from './protocol.js';

export const CIRCLE_FACILITATOR_URL = 'https://api.circle.com/v1/facilitator/x402';

/** Circle's seller proof may be valid for at most five minutes. */
const PROOF_LIFETIME_SECONDS = 300;
/** Settling waits for the transaction; Circle can take a while under load. */
const REQUEST_TIMEOUT_MS = 60_000;
const STATUS_POLL_MS = 1_000;
const STATUS_TIMEOUT_MS = 60_000;

type Purpose = 'verify' | 'settle' | 'status';

/** Signs Circle's seller proof as the payee. Must be the key behind `payTo`. */
export type SellerSigner = (payTo: Address, data: TypedDataRequest) => Promise<Hex>;

/** Thrown for answers that are neither a verdict nor a settlement, such as an exhausted trial. */
export class CircleFacilitatorError extends Error {
  constructor(
    readonly status: number,
    readonly reasons: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = 'CircleFacilitatorError';
  }

  /** The keyless trial for this payee is used up: a Circle API key is needed from here on. */
  get trialExhausted(): boolean {
    return this.reasons.includes('registration_required');
  }
}

/**
 * Circle's hosted x402 Facilitator Service. Exact payments on Arc settle without an API
 * key: every request carries a "seller proof", an EIP-712 signature by the payee over the
 * request body, so only the merchant being paid can ask Circle to settle to it.
 */
export class CircleFacilitator implements Facilitator {
  readonly name = 'circle';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly sellerSigner: SellerSigner,
    opts: { baseUrl?: string; fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? CIRCLE_FACILITATOR_URL).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private readonly now: () => number;

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const res = await this.call('verify', requirements, { x402Version: X402_VERSION, paymentPayload: payload, paymentRequirements: requirements });
    return res as VerifyResponse;
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const settled = (await this.call('settle', requirements, {
      x402Version: X402_VERSION,
      paymentPayload: payload,
      paymentRequirements: requirements,
    })) as SettleResponse;
    if (settled.success || settled.errorReason !== 'settlement_pending') return settled;
    // Pending is not failure: Circle broadcast it and will report the outcome.
    const paymentId = pendingPaymentId(settled);
    return paymentId ? this.waitForSettlement(paymentId, requirements, settled) : settled;
  }

  private async waitForSettlement(paymentId: string, requirements: PaymentRequirements, pending: SettleResponse): Promise<SettleResponse> {
    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
      const status = (await this.call('status', requirements, undefined, `/status/${encodeURIComponent(paymentId)}`)) as {
        status?: string;
        transaction?: string | null;
        payer?: string | null;
        amount?: string;
        reason?: string | null;
      };
      if (status.status === 'completed' && status.transaction) {
        return { success: true, transaction: status.transaction, network: requirements.network, ...(status.payer ? { payer: status.payer } : {}) };
      }
      if (status.status === 'failed') {
        return { success: false, errorReason: status.reason ?? 'settlement_failed', transaction: status.transaction ?? '', network: requirements.network };
      }
    }
    // Still pending: the payment may yet settle, so this is reported as pending, never as failed.
    return pending;
  }

  /** One request with a fresh seller proof. Verdicts come back as 200; anything else throws. */
  private async call(purpose: Purpose, requirements: PaymentRequirements, body: unknown, path = `/${purpose}`): Promise<unknown> {
    const method = body === undefined ? 'GET' : 'POST';
    const text = body === undefined ? '' : JSON.stringify(body);
    const proof = await this.sellerProof(purpose, method, text, requirements);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Facilitator-Seller-Proof': proof, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed: unknown = await res.json().catch(() => ({}));
    if (res.ok) return parsed;
    const error = parsed as { message?: string; errors?: { reason?: string }[] };
    const reasons = (error.errors ?? []).flatMap((e) => (e.reason ? [e.reason] : []));
    throw new CircleFacilitatorError(
      res.status,
      reasons,
      `Circle facilitator answered ${res.status} to ${purpose}: ${error.message ?? 'no message'}${reasons.length ? ` (${reasons.join(', ')})` : ''}`,
    );
  }

  /** Circle's "Facilitator-Seller-Proof" header: base64url JSON around an EIP-712 signature by the payee. */
  private async sellerProof(purpose: Purpose, method: string, body: string, requirements: PaymentRequirements): Promise<string> {
    const payTo = requirements.payTo.toLowerCase() as Address;
    const nonce = toHex(randomBytes(32));
    const issuedAt = this.now();
    const expiresAt = issuedAt + PROOF_LIFETIME_SECONDS;
    const signature = await this.sellerSigner(payTo, sellerRequestTypedData({
      chainId: chainIdOf(requirements.network),
      purpose,
      method,
      bodyHash: keccak256(toBytes(body)),
      network: requirements.network,
      payTo,
      nonce,
      issuedAt,
      expiresAt,
    }));
    const envelope = { version: 1, signature, network: requirements.network, payTo: requirements.payTo, nonce, issuedAt, expiresAt };
    return Buffer.from(JSON.stringify(envelope)).toString('base64url');
  }
}

/** The EIP-712 message of Circle's seller proof. */
export function sellerRequestTypedData(args: {
  chainId: number;
  purpose: Purpose;
  method: string;
  bodyHash: Hex;
  network: string;
  payTo: Address;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
}): TypedDataRequest {
  return {
    domain: { name: 'Circle Facilitator Seller Request', version: '1', chainId: args.chainId },
    types: {
      SellerRequest: [
        { name: 'purpose', type: 'string' },
        { name: 'method', type: 'string' },
        { name: 'bodyHash', type: 'bytes32' },
        { name: 'network', type: 'string' },
        { name: 'payTo', type: 'address' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    primaryType: 'SellerRequest',
    message: {
      purpose: args.purpose,
      method: args.method,
      bodyHash: args.bodyHash,
      network: args.network,
      payTo: args.payTo,
      nonce: args.nonce,
      issuedAt: BigInt(args.issuedAt),
      expiresAt: BigInt(args.expiresAt),
    },
  };
}

function pendingPaymentId(settled: SettleResponse): string | undefined {
  const status = settled.extensions?.['settlement-status'] as { paymentId?: unknown; info?: { paymentId?: unknown } } | undefined;
  const id = status?.paymentId ?? status?.info?.paymentId;
  return typeof id === 'string' ? id : undefined;
}
