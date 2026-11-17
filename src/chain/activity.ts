import { z } from 'zod';
import { ARC_TESTNET, USDC_ADDRESS, formatUsdc } from '../constants.js';
import type { Address, TxHash, Usdc } from '../types.js';

/** One USDC transfer an address sent or received. */
export interface UsdcTransfer {
  txHash: TxHash;
  from: Address;
  to: Address;
  amount: Usdc;
  blockNumber: number;
}

/** Recent USDC transfers of one address, newest first. */
export interface ActivityReader {
  getUsdcActivity(address: Address, limit: number): Promise<UsdcTransfer[]>;
}

/** What the paid API returns. Compact, because an agent reads it as one tool result. */
export interface ActivityReport {
  address: Address;
  transfers: { tx: TxHash; from: Address; to: Address; amount_usdc: string; block: number }[];
}

/** Keeps a report well under the 4,000 characters an agent's tool result may carry. */
export const ACTIVITY_LIMIT = 10;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const REQUEST_TIMEOUT_MS = 10_000;

const partySchema = z.object({ hash: z.string().regex(ADDRESS) });

const responseSchema = z.object({ items: z.array(z.unknown()) });

/** The fields used from one entry of the explorer's token-transfer list. Everything else is ignored. */
const itemSchema = z.object({
  block_number: z.number().int().nonnegative(),
  transaction_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  from: partySchema,
  to: partySchema,
  token: z.object({ address_hash: z.string().regex(ADDRESS) }),
  total: z.object({ value: z.string().regex(/^\d+$/) }),
});

const lower = (address: string): Address => address.toLowerCase() as Address;

/**
 * Reads an address's USDC history from the Arc Testnet explorer. The RPC node only serves
 * logs for about a thousand blocks per call, which on a sub-second chain is minutes of
 * history, so the explorer's index is the practical source.
 */
export class ExplorerActivityReader implements ActivityReader {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = opts.baseUrl ?? ARC_TESTNET.explorerApiUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getUsdcActivity(address: Address, limit: number): Promise<UsdcTransfer[]> {
    // Checked here because the address becomes part of a URL path.
    if (!ADDRESS.test(address)) throw new Error(`${address} is not a valid address`);
    const url = new URL(`/api/v2/addresses/${address}/token-transfers`, this.baseUrl);
    url.searchParams.set('type', 'ERC-20');
    url.searchParams.set('token', USDC_ADDRESS);

    const res = await this.fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Explorer returned ${res.status} for the activity of ${address}`);
    const parsed = responseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Explorer response has an unexpected shape: ${issue?.path.join('.')}: ${issue?.message}`);
    }

    // Entries are read one by one: a single odd one (another token standard, a missing
    // field) is dropped instead of failing a report the buyer has already paid for.
    const items = parsed.data.items.flatMap((raw) => {
      const item = itemSchema.safeParse(raw);
      return item.success ? [item.data] : [];
    });
    if (parsed.data.items.length > 0 && items.length === 0) {
      throw new Error('Explorer response has an unexpected shape: no entry could be read as a token transfer');
    }

    return items
      .filter((item) => lower(item.token.address_hash) === lower(USDC_ADDRESS))
      .slice(0, limit)
      .map((item) => ({
        txHash: item.transaction_hash.toLowerCase() as TxHash,
        from: lower(item.from.hash),
        to: lower(item.to.hash),
        amount: BigInt(item.total.value),
        blockNumber: item.block_number,
      }));
  }
}

/** The report a merchant sells: the address's most recent USDC transfers. */
export async function buildActivityReport(reader: ActivityReader, address: Address): Promise<ActivityReport> {
  const transfers = await reader.getUsdcActivity(address, ACTIVITY_LIMIT);
  return {
    address,
    transfers: transfers.map((t) => ({
      tx: t.txHash,
      from: t.from,
      to: t.to,
      amount_usdc: formatUsdc(t.amount),
      block: t.blockNumber,
    })),
  };
}
