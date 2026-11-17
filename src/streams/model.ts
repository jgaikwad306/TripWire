import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { keccak256, toHex } from 'viem';
import { USDC_ADDRESS } from '../constants.js';
import type { Address, TxHash } from '../types.js';

export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const AUTHORIZATION_USED = keccak256(toHex('AuthorizationUsed(address,bytes32)'));
export const NATIVE_USDC = '0xfffffffffffffffffffffffffffffffffffffffe';
export const LEGACY_USDC = '0x1800000000000000000000000000000000000000';
export const LEGACY_TRANSFER = '0x62f084c00a442dcf51cdbb51beed2839bf42a268da8474b0e98f38edb7db5a22';
export const NATIVE_SCALE = 1_000_000_000_000n;
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v => v.toLowerCase() as Address);
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as TxHash);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const logSchema = z.object({ address: addressSchema, topics: z.array(hashSchema).max(4), data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/), logIndex: integer }).superRefine((log, ctx) => {
  const transfer = (log.topics[0] === TRANSFER && [NATIVE_USDC, USDC_ADDRESS.toLowerCase()].includes(log.address)) || (log.topics[0] === LEGACY_TRANSFER && log.address === LEGACY_USDC);
  if (transfer && (log.topics.length !== 3 || !/^0x[0-9a-f]{64}$/i.test(log.data))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Malformed USDC Transfer log' });
});
export const receiptSchema = z.object({ transactionHash: hashSchema, blockHash: hashSchema, blockNumber: integer, status: z.enum(['success', 'reverted']), logs: z.array(logSchema) });
export const blockSchema = z.object({ number: integer, hash: hashSchema, parentHash: hashSchema, timestamp: integer, receipts: z.array(receiptSchema) });
export const batchSchema = z.object({ version: z.literal(1), network: z.literal('arc-testnet'), streamId: z.string().min(1), blocks: z.array(blockSchema).min(1).max(1000) });
export type StreamBlock = z.infer<typeof blockSchema>;
export type StreamReceipt = z.infer<typeof receiptSchema>;
export type StreamBatch = z.infer<typeof batchSchema>;
export const walletsSchema = z.object({ hot: addressSchema, vault: addressSchema, merchant: addressSchema });
export type WatchedWallets = z.infer<typeof walletsSchema>;
export const configurationSchema = z.object({
  streamId: z.string().min(1), startBlock: integer, liveBoundary: integer, wallets: walletsSchema,
}).refine(c => c.startBlock <= c.liveBoundary, 'Backfill must start at or before the live boundary');
export type StreamConfiguration = z.infer<typeof configurationSchema>;
export const expectationSchema = z.object({
  id: z.string().min(1).max(200), from: addressSchema, to: addressSchema,
  amount: z.string().regex(/^[1-9]\d*$/), nonce: hashSchema.optional(),
});
export type ExpectedOutflow = z.infer<typeof expectationSchema>;
export interface SpendingSafety {
  check(): Promise<void>;
  reserve(outflow: ExpectedOutflow): Promise<void>;
  submitted(id: string, txHash: TxHash): Promise<void>;
}
export const topicAddress = (topic: string): Address => `0x${topic.slice(-40)}` as Address;

export function renderFilter(wallets: WatchedWallets): string {
  const source = readFileSync(new URL('./filter.js', import.meta.url), 'utf8');
  return source.replace('/*WATCHED_ADDRESSES*/ []', JSON.stringify(Object.values(walletsSchema.parse(wallets))));
}

/** Native logs are the canonical movement stream; ERC-20 logs remain receipt evidence. */
export function movements(receipt: StreamReceipt) {
  if (receipt.status !== 'success') return [];
  const native = receipt.logs.filter(l => (l.address === NATIVE_USDC && l.topics[0] === TRANSFER) || (l.address === LEGACY_USDC && l.topics[0] === LEGACY_TRANSFER));
  const logs = native.length ? native : receipt.logs.filter(l => l.address === USDC_ADDRESS.toLowerCase() && l.topics[0] === TRANSFER);
  return logs.filter(l => l.topics.length === 3 && /^0x[0-9a-f]{64}$/i.test(l.data)).map(l => ({
    logIndex: l.logIndex, from: topicAddress(l.topics[1]!), to: topicAddress(l.topics[2]!),
    amountNative: BigInt(l.data) * (native.length ? 1n : NATIVE_SCALE),
  })).filter(m => m.amountNative > 0n && m.from !== m.to);
}
