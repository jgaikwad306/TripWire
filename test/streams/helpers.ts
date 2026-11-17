import { USDC_ADDRESS } from '../../src/constants.js';
import { AUTHORIZATION_USED, NATIVE_USDC, NATIVE_SCALE, TRANSFER, type StreamBatch, type StreamBlock, type StreamReceipt } from '../../src/streams/model.js';
import { FAKE_ADDRESSES } from '../../src/fakes/index.js';
import type { Address, TxHash } from '../../src/types.js';
export const wallets = { hot: FAKE_ADDRESSES.hot, vault: FAKE_ADDRESSES.vault, merchant: FAKE_ADDRESSES.merchant };
export const OTHER = FAKE_ADDRESSES.attacker;
export const NOW = 1_800_000_000_000;
export const hash = (n: number): TxHash => `0x${n.toString(16).padStart(64, '0')}`;
export const topic = (address: string): TxHash => `0x${address.slice(2).padStart(64, '0')}`;
export const data = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
export function transferReceipt(block: number, opts: { from?: Address; to?: Address; amount?: bigint; nonce?: TxHash; nativeOnly?: boolean; dust?: boolean } = {}): StreamReceipt {
  const from = opts.from ?? wallets.hot, to = opts.to ?? OTHER, amount = opts.amount ?? 1_000_000n;
  const logs: StreamReceipt['logs'] = [{ address: NATIVE_USDC, topics: [TRANSFER, topic(from), topic(to)], data: data(opts.dust ? 1n : amount * NATIVE_SCALE), logIndex: 0 }];
  if (!opts.nativeOnly) logs.push({ address: USDC_ADDRESS, topics: [TRANSFER, topic(from), topic(to)], data: data(amount), logIndex: 1 });
  if (opts.nonce) logs.push({ address: USDC_ADDRESS, topics: [AUTHORIZATION_USED, topic(from), opts.nonce], data: '0x', logIndex: 2 });
  return { transactionHash: hash(block + 1000), blockNumber: block, blockHash: hash(block), status: 'success', logs };
}
export const block = (n: number, receipts: StreamReceipt[] = []): StreamBlock => ({ number: n, hash: hash(n), parentHash: hash(n - 1), timestamp: NOW / 1000, receipts });
export const batch = (...blocks: StreamBlock[]): StreamBatch => ({ version: 1, network: 'arc-testnet', streamId: 'stream-1', blocks });
export const configuration = { streamId: 'stream-1', startBlock: 98, liveBoundary: 100, wallets };
