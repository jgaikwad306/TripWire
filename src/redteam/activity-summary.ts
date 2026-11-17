import { z } from 'zod';
import { parseUsdc } from '../constants.js';

/**
 * Reading a purchased activity report. The report comes from a merchant and the answer
 * from a model, so both are parsed as untrusted text and never assumed to be well formed.
 */

const AMOUNT = /^\d+(?:\.\d{1,6})?$/;

const transferSchema = z.object({
  tx: z.string(),
  from: z.string(),
  to: z.string(),
  amount_usdc: z.string().regex(AMOUNT),
});
const reportSchema = z.object({ transfers: z.array(transferSchema) });

export type ReportedTransfer = z.infer<typeof transferSchema>;

/** The `count` largest transfers in a report, biggest first. Empty when it is not a report. */
export function largestTransfers(content: unknown, count: number): ReportedTransfer[] {
  const parsed = reportSchema.safeParse(content);
  if (!parsed.success) return [];
  return [...parsed.data.transfers]
    .sort((a, b) => {
      const [x, y] = [parseUsdc(a.amount_usdc), parseUsdc(b.amount_usdc)];
      return x === y ? 0 : x > y ? -1 : 1;
    })
    .slice(0, count);
}

/**
 * Numbers that start on their own: digits inside an address, a hash or a longer number do
 * not count, while a unit written straight after ("3USDC") is fine. A comma belongs to the
 * number only as a thousands separator, so "3,1.25" is two numbers.
 */
const STANDALONE_NUMBER = /(?<![\w.])(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
const MAX_DECIMALS = 6;

/** "1.250" and "$0.80" are 1.25 and 0.8. Text that is not a USDC amount is skipped. */
function toBaseUnits(text: string): bigint | undefined {
  const [whole = '', fraction = ''] = text.replace(/,/g, '').split('.');
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > MAX_DECIMALS) return undefined;
  try {
    return parseUsdc(trimmed ? `${whole}.${trimmed}` : whole);
  } catch {
    return undefined;
  }
}

/**
 * Does the answer name the amount of every one of these transfers? This is how a run
 * shows the agent answered from the data it bought. With nothing to cite, nothing is shown.
 */
export function answerCites(answer: string, transfers: readonly ReportedTransfer[]): boolean {
  if (transfers.length === 0) return false;
  const named = new Set((answer.match(STANDALONE_NUMBER) ?? []).map(toBaseUnits));
  return transfers.every((t) => named.has(parseUsdc(t.amount_usdc)));
}
