import { CHAIN_CONFIGS, GATEWAY_DOMAINS } from '@circle-fin/x402-batching/client';
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';
import { randomUUID } from 'node:crypto';
import { getAddress, recoverTypedDataAddress } from 'viem';
import { USDC_ADDRESS, parseUsdc } from '../constants.js';
import type { Address, Usdc } from '../types.js';
import type { Facilitator } from './facilitator.js';
import {
  ARC_NETWORK,
  GATEWAY_BATCHED_NAME,
  authorizationTypedData,
  eip3009Of,
  isGatewayOption,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
  type VerifyResponse,
} from './protocol.js';

/**
 * Circle Gateway nanopayments on Arc Testnet: x402 "exact" payments signed against the
 * Gateway Wallet instead of USDC itself. The buyer deposits USDC into Gateway once; each
 * payment is then a gasless signed authorization that Gateway checks instantly and settles
 * onchain later, many at a time. Addresses come from Circle's own SDK.
 */
const ARC = CHAIN_CONFIGS.arcTestnet;

/** The Gateway Wallet contract on Arc Testnet: where deposits live, and the payments' EIP-712 verifying contract. */
export const GATEWAY_WALLET = getAddress(ARC.gatewayWallet).toLowerCase() as Address;
/** Gateway's domain number for Arc Testnet (not the chain id). */
export const GATEWAY_DOMAIN = GATEWAY_DOMAINS.arcTestnet;
/** Gateway's testnet API. Testnet only: this project never pays on mainnet. */
export const GATEWAY_TESTNET_API = 'https://gateway-api-testnet.circle.com';
/**
 * How long a Gateway payment authorization stays valid. Gateway batches settlement, so it
 * refuses authorizations valid for less than a week; Circle's SDK signs for a week plus a buffer.
 */
export const GATEWAY_VALIDITY_SECONDS = 7 * 24 * 60 * 60 + 100;
/** Gateway's own floor, used to judge authorizations presented to us. */
const GATEWAY_MIN_VALIDITY_SECONDS = 3 * 24 * 60 * 60;

/** A Gateway batched payment option: USDC on Arc, signed against the Gateway Wallet. */
export function gatewayRequirements(payTo: Address, amount: Usdc): PaymentRequirements {
  return {
    scheme: 'exact',
    network: ARC_NETWORK,
    asset: getAddress(USDC_ADDRESS),
    amount: amount.toString(),
    payTo: getAddress(payTo),
    maxTimeoutSeconds: GATEWAY_VALIDITY_SECONDS,
    extra: { name: GATEWAY_BATCHED_NAME, version: '1', verifyingContract: getAddress(GATEWAY_WALLET) },
  };
}

/** Is this option a genuine Gateway payment on Arc: the real Gateway Wallet, version 1, USDC? */
export function isArcGatewayOption(requirements: PaymentRequirements): boolean {
  const contract = requirements.extra?.verifyingContract;
  return (
    isGatewayOption(requirements) &&
    requirements.network === ARC_NETWORK &&
    requirements.asset.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
    typeof contract === 'string' &&
    contract.toLowerCase() === GATEWAY_WALLET
  );
}

/** One x402 transfer as Gateway records it. Amounts in USDC base units. */
export interface GatewayTransfer {
  id: string;
  /** received → batched → confirmed → completed, or failed. */
  status: 'received' | 'batched' | 'confirmed' | 'completed' | 'failed';
  from: Address;
  to: Address;
  amount: Usdc;
  nonce: `0x${string}`;
  /** The onchain batch settlement, once there is one. */
  txHash?: `0x${string}`;
  createdAt: string;
}

/** Has Gateway accepted this transfer? Anything but failed means the buyer's balance was committed. */
export const transferCounts = (transfer: GatewayTransfer): boolean => transfer.status !== 'failed';

/** Read-only view of Gateway: balances and the transfers it has accepted. */
export interface GatewayReader {
  /** USDC deposited in Gateway by this address on Arc, in base units. */
  balance(address: Address): Promise<Usdc>;
  /** The transfer made with this payer's authorization nonce, if Gateway has it. */
  transferByNonce(from: Address, nonce: `0x${string}`): Promise<GatewayTransfer | undefined>;
  /** Transfers matching the filter, oldest first. */
  transfers(filter: { from?: Address; to?: Address; since?: Date }): Promise<GatewayTransfer[]>;
}

const STATUSES = new Set(['received', 'batched', 'confirmed', 'completed', 'failed']);

/** A transfer from Gateway's API: decimal-free base units arrive as strings. */
function parseTransfer(raw: Record<string, unknown>): GatewayTransfer | undefined {
  const { id, status, fromAddress, toAddress, amount, nonce, txHash, createdAt } = raw;
  if (typeof id !== 'string' || typeof status !== 'string' || !STATUSES.has(status)) return undefined;
  if (typeof fromAddress !== 'string' || typeof toAddress !== 'string' || typeof nonce !== 'string') return undefined;
  if (typeof amount !== 'string' || !/^\d+(\.\d+)?$/.test(amount)) return undefined;
  return {
    id,
    status: status as GatewayTransfer['status'],
    from: fromAddress.toLowerCase() as Address,
    to: toAddress.toLowerCase() as Address,
    // Gateway reports base units; a decimal string would be a dollar amount.
    amount: amount.includes('.') ? parseUsdc(amount) : BigInt(amount),
    nonce: nonce.toLowerCase() as `0x${string}`,
    ...(typeof txHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(txHash) ? { txHash: txHash as `0x${string}` } : {}),
    createdAt: typeof createdAt === 'string' ? createdAt : new Date(0).toISOString(),
  };
}

const MAX_PAGES = 20;

/** Gateway's public testnet API. Needs no key. */
export class HttpGatewayReader implements GatewayReader {
  constructor(
    private readonly baseUrl: string = GATEWAY_TESTNET_API,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async balance(address: Address): Promise<Usdc> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/balances`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'USDC', sources: [{ domain: GATEWAY_DOMAIN, depositor: address }] }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => undefined)) as { balances?: { domain: number; balance: string }[] } | undefined;
    if (!res.ok || !body?.balances) throw new Error(`Gateway balances failed (${res.status}).`);
    const entry = body.balances.find((b) => b.domain === GATEWAY_DOMAIN);
    return entry ? parseUsdc(entry.balance) : 0n;
  }

  async transferByNonce(from: Address, nonce: `0x${string}`): Promise<GatewayTransfer | undefined> {
    const found = await this.search({ from, nonce });
    return found.find((t) => t.nonce === nonce.toLowerCase());
  }

  async transfers(filter: { from?: Address; to?: Address; since?: Date }): Promise<GatewayTransfer[]> {
    return this.search({
      ...(filter.from ? { from: filter.from } : {}),
      ...(filter.to ? { to: filter.to } : {}),
      ...(filter.since ? { startDate: filter.since.toISOString() } : {}),
    });
  }

  private async search(params: Record<string, string>): Promise<GatewayTransfer[]> {
    const found: GatewayTransfer[] = [];
    let pageAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ ...params, network: ARC_NETWORK, pageSize: '100', ...(pageAfter ? { pageAfter } : {}) });
      const res = await this.fetchImpl(`${this.baseUrl}/v1/x402/transfers?${query.toString().replaceAll('%3A', ':')}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`Gateway transfer search failed (${res.status}): ${await res.text().catch(() => '')}`);
      const body = (await res.json()) as { transfers?: Record<string, unknown>[] };
      for (const raw of body.transfers ?? []) {
        const transfer = parseTransfer(raw);
        if (transfer) found.push(transfer);
      }
      pageAfter = /[?&]pageAfter=([^&>]+)[^>]*>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
      if (!pageAfter) break;
    }
    return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/**
 * Circle Gateway as the seller's facilitator: verify and settle through Gateway's x402
 * endpoints with Circle's own BatchFacilitatorClient.
 */
export class GatewayFacilitator implements Facilitator {
  readonly name = 'circle-gateway';
  private readonly client: BatchFacilitatorClient;

  constructor(url: string = GATEWAY_TESTNET_API) {
    this.client = new BatchFacilitatorClient({ url });
  }

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    // The SDK compiles against its own copy of the x402 types; the wire format is the same.
    return this.client.verify(payload as never, requirements as never) as Promise<VerifyResponse>;
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const settled = await this.client.settle(payload as never, requirements as never);
    return { ...settled, network: settled.network ?? requirements.network } as SettleResponse;
  }
}

/**
 * Gateway for offline runs: deposits, instant verification and settlement, and the
 * transfer record, all in memory. It checks what the real Gateway checks: the Gateway
 * Wallet domain and signature, payee, exact amount, validity window, nonce and balance.
 */
export class FakeGateway implements Facilitator, GatewayReader {
  readonly name = 'gateway-offline';
  private readonly balances = new Map<Address, Usdc>();
  private readonly log: GatewayTransfer[] = [];

  constructor(private readonly unixNow: () => number = () => Math.floor(Date.now() / 1000)) {}

  deposit(address: Address, amount: Usdc): void {
    const key = address.toLowerCase() as Address;
    this.balances.set(key, (this.balances.get(key) ?? 0n) + amount);
  }

  async balance(address: Address): Promise<Usdc> {
    return this.balances.get(address.toLowerCase() as Address) ?? 0n;
  }

  async transferByNonce(from: Address, nonce: `0x${string}`): Promise<GatewayTransfer | undefined> {
    return this.log.find((t) => t.from === from.toLowerCase() && t.nonce === nonce.toLowerCase());
  }

  async transfers(filter: { from?: Address; to?: Address; since?: Date }): Promise<GatewayTransfer[]> {
    return this.log.filter(
      (t) =>
        (!filter.from || t.from === filter.from.toLowerCase()) &&
        (!filter.to || t.to === filter.to.toLowerCase()) &&
        (!filter.since || t.createdAt >= filter.since.toISOString()),
    );
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const reason = await this.problem(payload, requirements);
    const payer = eip3009Of(payload)?.authorization.from;
    return reason ? { isValid: false, invalidReason: reason, ...(payer ? { payer } : {}) } : { isValid: true, payer: payer! };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const reason = await this.problem(payload, requirements);
    if (reason) return { success: false, errorReason: reason, transaction: '', network: requirements.network };
    const { from, to, value, nonce } = eip3009Of(payload)!.authorization;
    const amount = BigInt(value);
    this.balances.set(from, (this.balances.get(from) ?? 0n) - amount);
    this.deposit(to, amount);
    const transfer: GatewayTransfer = { id: randomUUID(), status: 'completed', from, to, amount, nonce, createdAt: new Date().toISOString() };
    this.log.push(transfer);
    return { success: true, transaction: transfer.id, network: requirements.network, payer: from } as SettleResponse;
  }

  /** Gateway's error code for what is wrong with this payment, or undefined when it is good. */
  private async problem(payload: PaymentPayload, requirements: PaymentRequirements): Promise<string | undefined> {
    if (requirements.scheme !== 'exact') return 'unsupported_scheme';
    if (requirements.network !== ARC_NETWORK) return 'unsupported_network';
    if (requirements.asset.toLowerCase() !== USDC_ADDRESS.toLowerCase()) return 'unsupported_asset';
    if (!isArcGatewayOption(requirements)) return 'wallet_not_found';
    const signed = eip3009Of(payload);
    if (!signed) return 'invalid_payload';
    const { from, to, value, validAfter, validBefore, nonce } = signed.authorization;
    if (to !== requirements.payTo.toLowerCase()) return 'address_mismatch';
    if (value !== requirements.amount) return 'amount_mismatch';
    if (from === to) return 'self_transfer';
    const now = this.unixNow();
    if (Number(validAfter) > now) return 'authorization_not_yet_valid';
    if (Number(validBefore) <= now) return 'authorization_expired';
    if (Number(validBefore) < now + GATEWAY_MIN_VALIDITY_SECONDS) return 'authorization_validity_too_short';
    try {
      const typed = authorizationTypedData(requirements, signed.authorization);
      const signer = await recoverTypedDataAddress({ ...(typed as Parameters<typeof recoverTypedDataAddress>[0]), signature: signed.signature });
      if (signer.toLowerCase() !== from) return 'invalid_signature';
    } catch {
      return 'invalid_signature';
    }
    if (this.log.some((t) => t.from === from && t.nonce === nonce)) return 'nonce_already_used';
    if ((this.balances.get(from) ?? 0n) < BigInt(value)) return 'insufficient_balance';
    return undefined;
  }
}
