import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { renderFilter, batchSchema, LEGACY_TRANSFER, LEGACY_USDC, movements, type StreamReceipt } from '../../src/streams/model.js';
import { block, hash, NOW, OTHER, transferReceipt, wallets } from './helpers.js';

function run(receipts: ReturnType<typeof transferReceipt>[]) {
  const b = block(101, receipts);
  return runInNewContext(`${renderFilter(wallets)}\nmain(input)`, { input: {
    metadata: { network: 'arc-testnet', stream_id: 'stream-1' },
    data: [{ block: { ...b, number: '0x65', timestamp: '0x' + (NOW / 1000).toString(16) }, receipts: receipts.map(r => ({ ...r, blockNumber: '0x65', status: r.status === 'success' ? '0x1' : '0x0', logs: r.logs.map(l => ({ ...l, logIndex: '0x' + l.logIndex.toString(16) })) })) }],
  } });
}
describe('deployable QuickNode filter', () => {
  it('runs without imports or SDK helpers and emits empty block checkpoints', () => {
    const payload = batchSchema.parse(run([]));
    expect(payload.blocks[0]).toMatchObject({ number: 101, hash: hash(101), receipts: [] });
  });
  it('selects wallet and merchant receipts but rejects counterfeit and unrelated emitters', () => {
    const watched = transferReceipt(101, { to: wallets.merchant });
    const fake = { ...transferReceipt(101), transactionHash: hash(222), logs: watched.logs.map(l => ({ ...l, address: OTHER })) };
    const unrelated = transferReceipt(101, { from: OTHER, to: OTHER });
    expect(batchSchema.parse(run([watched, fake, unrelated])).blocks[0]!.receipts).toHaveLength(1);
  });
  it('captures native-only transfers and historical native events at original precision', () => {
    const native = transferReceipt(101, { nativeOnly: true, dust: true });
    expect(movements(batchSchema.parse(run([native])).blocks[0]!.receipts[0]!)[0]!.amountNative).toBe(1n);
    const legacy: StreamReceipt = { ...native, logs: native.logs.map(l => ({ ...l, address: LEGACY_USDC, topics: [LEGACY_TRANSFER, ...l.topics.slice(1)] })) };
    expect(movements(batchSchema.parse(run([legacy])).blocks[0]!.receipts[0]!)[0]!.amountNative).toBe(1n);
  });
});
