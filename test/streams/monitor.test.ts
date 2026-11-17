import { fsyncSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamMonitor } from '../../src/streams/monitor.js';
import { batch, block, configuration, hash, NOW, OTHER, transferReceipt, wallets } from './helpers.js';

const opened: StreamMonitor[] = [];
afterEach(() => { for (const m of opened.splice(0)) m.close(); });
function setup() {
  let now = NOW;
  const dir = mkdtempSync(join(tmpdir(), 'tripwire-streams-'));
  const monitor = new StreamMonitor(dir, () => now); opened.push(monitor);
  monitor.configure(configuration);
  monitor.ingest(batch(block(98), block(99), block(100)));
  return { monitor, dir, advance: (ms: number) => { now += ms; }, clock: () => now };
}
describe('durable USDC outflow monitoring', () => {
  it('does not authorize an outflow when its reservation cannot be flushed to disk', () => {
    let fail = false;
    const monitor = new StreamMonitor(mkdtempSync(join(tmpdir(), 'tripwire-storage-')), () => NOW, fd => {
      if (fail) throw new Error('Simulated storage failure');
      fsyncSync(fd);
    }); opened.push(monitor);
    monitor.configure(configuration);
    monitor.ingest(batch(block(98), block(99), block(100)));
    fail = true;
    expect(() => monitor.reserve({ id: 'unsafe', from: wallets.hot, to: OTHER, amount: '1000000' })).toThrow(/storage failed/);
    expect(monitor.expected.has('unsafe')).toBe(false);
    expect(() => monitor.check()).toThrow(/storage failed/);
  });
  it('backfills historical outflows without freezing and requires contiguous coverage', () => {
    const { monitor } = setup();
    expect(monitor.status()).toMatchObject({ ready: true, coveredThrough: 100 });
    monitor.ingest(batch(block(102)));
    expect(monitor.status()).toMatchObject({ ready: false, reason: 'Stream coverage has a gap' });
    monitor.ingest(batch(block(101)));
    expect(monitor.status().ready).toBe(true);
    const other = new StreamMonitor(mkdtempSync(join(tmpdir(), 'tripwire-history-')), () => NOW); opened.push(other);
    other.configure(configuration);
    other.ingest(batch(block(98, [transferReceipt(98)]), block(99), block(100)));
    expect(other.status()).toMatchObject({ ready: true, frozen: false });
  });
  it('matches the authorization nonce before the merchant response arrives and counts mirrored logs once', () => {
    const { monitor } = setup();
    monitor.reserve({ id: 'pay', from: wallets.hot, to: wallets.merchant, amount: '1000000', nonce: hash(999) });
    monitor.ingest(batch(block(101, [transferReceipt(101, { to: wallets.merchant, nonce: hash(999) })])));
    expect(monitor.status()).toMatchObject({ ready: true, frozen: false });
    expect(monitor.status().recentTransfers).toHaveLength(1);
  });
  it('does not accept an allowlisted payee or a different nonce as proof of authorization', () => {
    const { monitor } = setup();
    monitor.reserve({ id: 'pay', from: wallets.hot, to: wallets.merchant, amount: '1000000', nonce: hash(999) });
    monitor.ingest(batch(block(101, [transferReceipt(101, { to: wallets.merchant, nonce: hash(998) })])));
    expect(monitor.status()).toMatchObject({ ready: false, frozen: true });
  });
  it('waits for a direct transaction hash and then classifies an expected vault sweep', () => {
    const { monitor } = setup();
    monitor.reserve({ id: 'sweep', from: wallets.hot, to: wallets.vault, amount: '1000000' });
    const receipt = transferReceipt(101, { to: wallets.vault });
    monitor.ingest(batch(block(101, [receipt])));
    expect(monitor.status()).toMatchObject({ ready: false, frozen: false, pending: 1 });
    monitor.submitted('sweep', receipt.transactionHash);
    expect(monitor.status()).toMatchObject({ ready: true, frozen: false, pending: 0 });
  });
  it('freezes an unresolved direct transfer after two minutes without renewing its reservation', () => {
    const { monitor, advance } = setup();
    monitor.reserve({ id: 'sweep', from: wallets.hot, to: wallets.vault, amount: '1000000' });
    monitor.ingest(batch(block(101, [transferReceipt(101, { to: wallets.vault })])));
    advance(120_001);
    expect(monitor.status()).toMatchObject({ frozen: true, pending: 0 });
    expect(() => monitor.reserve({ id: 'sweep', from: wallets.hot, to: wallets.vault, amount: '1000000' })).toThrow();
  });
  it('detects tiny native sends and vault outflows without requiring an ERC-20 log', () => {
    const { monitor } = setup();
    monitor.ingest(batch(block(101, [transferReceipt(101, { from: wallets.vault, nativeOnly: true, dust: true })])));
    expect(monitor.status()).toMatchObject({ frozen: true });
    expect(monitor.status().alerts[0]).toMatchObject({ reason: 'Unexpected vault outflow', amountNative: '1' });
  });
  it('consumes an expected authorization only once and detects extra movements in the same transaction', () => {
    const { monitor } = setup();
    monitor.reserve({ id: 'pay', from: wallets.hot, to: OTHER, amount: '1000000', nonce: hash(999) });
    const receipt = transferReceipt(101, { nonce: hash(999) });
    receipt.logs.push({ ...receipt.logs[0]!, logIndex: 3 });
    monitor.ingest(batch(block(101, [receipt])));
    expect(monitor.status().alerts).toHaveLength(1);
  });
  it('persists freezes and owner acknowledgments; retries neither duplicate alerts nor grow the journal', () => {
    const { monitor, dir, clock } = setup();
    const delivery = batch(block(101, [transferReceipt(101)]));
    monitor.ingest(delivery);
    const before = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
    monitor.ingest(delivery);
    expect(readFileSync(join(dir, 'journal.jsonl'), 'utf8')).toBe(before);
    const restarted = new StreamMonitor(dir, clock); opened.push(restarted);
    expect(restarted.status()).toMatchObject({ frozen: true });
    restarted.acknowledge(restarted.status().alerts[0]!.id, 'Owner reviewed controlled testnet transfer');
    const again = new StreamMonitor(dir, clock); opened.push(again);
    expect(again.status()).toMatchObject({ frozen: false, ready: true });
  });
  it('fails closed on stale delivery, malformed state, and conflicting finalized blocks', () => {
    const { monitor, advance, dir, clock } = setup();
    advance(60_001);
    expect(() => monitor.check()).toThrow(/60 seconds/);
    monitor.ingest(batch(block(101)));
    expect(monitor.status().ready).toBe(false); // old block timestamps do not prove catch-up
    expect(() => monitor.ingest(batch({ ...block(100), hash: hash(777) }))).toThrow(/Conflicting/);
    const restarted = new StreamMonitor(dir, clock); opened.push(restarted);
    expect(restarted.status().reason).toMatch(/Conflicting/);
    const corrupt = mkdtempSync(join(tmpdir(), 'tripwire-corrupt-'));
    writeFileSync(join(corrupt, 'journal.jsonl'), '{"type":');
    expect(() => new StreamMonitor(corrupt)).toThrow(/incomplete/);
  });
  it('ignores incoming, merchant, self and reverted movements; refuses wrong streams and receipt blocks', () => {
    const { monitor } = setup();
    const incoming = transferReceipt(101, { from: OTHER, to: wallets.hot });
    const merchant = { ...transferReceipt(101, { from: wallets.merchant }), transactionHash: hash(2222) };
    const reverted = { ...transferReceipt(101), transactionHash: hash(3333), status: 'reverted' as const };
    const self = { ...transferReceipt(101, { to: wallets.hot }), transactionHash: hash(4444) };
    monitor.ingest(batch(block(101, [incoming, merchant, reverted, self])));
    expect(monitor.status().ready).toBe(true);
    expect(() => monitor.ingest({ ...batch(block(102)), streamId: 'elsewhere' })).toThrow();
    expect(() => monitor.ingest(batch(block(102, [transferReceipt(101)])))).toThrow(/belong/);
  });
});
