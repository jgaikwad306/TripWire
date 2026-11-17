import type { Address, Quote, QuoteFetcher } from '../types.js';
import { HEADER, decode, pickRequirements } from '../x402/protocol.js';

const QUOTE_TIMEOUT_MS = 10_000;

/**
 * The real QuoteFetcher, done the x402 way: place the order without paying and read the
 * terms from the PAYMENT-REQUIRED header of the 402 that comes back. Only the header
 * counts; the response body is text for people and LLMs, and an attacker may write it.
 * The values are still untrusted: deciding whether to pay them is the guard's job.
 */
export function createHttpQuoteFetcher(fetchImpl: typeof fetch = fetch): QuoteFetcher {
  return async (merchantUrl, item, order = {}) => {
    const res = await fetchImpl(new URL('/buy', merchantUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...order, item }),
      signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
    });
    if (res.status !== 402) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Merchant answered ${res.status} instead of 402 Payment Required for "${item}"${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const header = res.headers.get(HEADER.required);
    if (!header) throw new Error(`Merchant's 402 for "${item}" has no ${HEADER.required} header, so it is not an x402 merchant.`);
    let required;
    try {
      required = decode.required(header);
    } catch {
      throw new Error(`Merchant's ${HEADER.required} header for "${item}" is malformed.`);
    }
    const requirements = pickRequirements(required);
    if (!requirements) throw new Error(`Merchant offers no exact USDC payment on Arc for "${item}".`);
    if (!/^\d+$/.test(requirements.amount) || !/^0x[0-9a-fA-F]{40}$/.test(requirements.payTo)) {
      throw new Error(`Malformed payment terms from merchant for "${item}".`);
    }
    const quote: Quote = {
      merchantUrl,
      item,
      payTo: requirements.payTo.toLowerCase() as Address,
      amount: BigInt(requirements.amount),
      requirements,
      ...(required.resource?.description ? { description: required.resource.description } : {}),
      ...(Object.keys(order).length > 0 ? { order } : {}),
    };
    return quote;
  };
}

/** The QuoteFetcher over global fetch. */
export const httpQuoteFetcher: QuoteFetcher = createHttpQuoteFetcher();
