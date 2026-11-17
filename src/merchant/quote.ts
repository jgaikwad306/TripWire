import { z } from 'zod';
import type { Address, QuoteFetcher } from '../types.js';

const quoteSchema = z.object({
  payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'payTo must be a 20-byte hex address'),
  amount: z.string().regex(/^\d+$/, 'amount must be base units as a decimal string'),
  description: z.string().max(2000).optional(),
});

/**
 * The real QuoteFetcher: GET {merchantUrl}/quote?item=…
 * Validates the response shape, but the values themselves are still untrusted —
 * deciding whether to believe them is the guard's job.
 */
export const httpQuoteFetcher: QuoteFetcher = async (merchantUrl, item) => {
  const url = new URL('/quote', merchantUrl);
  url.searchParams.set('item', item);
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Merchant returned ${res.status} for quote of "${item}"`);
  const parsed = quoteSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`Malformed quote from merchant: ${parsed.error.issues[0]?.message}`);
  return {
    merchantUrl,
    item,
    payTo: parsed.data.payTo.toLowerCase() as Address,
    amount: BigInt(parsed.data.amount),
    description: parsed.data.description,
  };
};
