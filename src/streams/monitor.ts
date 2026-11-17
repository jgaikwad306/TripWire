import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { TxHash } from '../types.js';
import {
  AUTHORIZATION_USED, NATIVE_SCALE, batchSchema, configurationSchema, expectationSchema,
  movements, topicAddress, type StreamBatch, type StreamConfiguration, type StreamReceipt,
} from './model.js';
import { USDC_ADDRESS } from '../constants.js';

const MAX_AGE_MS = 60_000;
const PENDING_MS = 120_000;
const expectationRecord = expectationSchema.extend({ at: z.number(), fromBlock: z.number().int().nonnegative(), txHash: z.string().optional() });
const recordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('configure'), config: configurationSchema }),
  z.object({ type: z.literal('reserve'), expectation: expectationRecord }),
  z.object({ type: z.literal('submitted'), id: z.string(), txHash: z.string().regex(/^0x[0-9a-f]{64}$/) }),
  z.object({ type: z.literal('batch'), batch: batchSchema, at: z.number() }),
  z.object({ type: z.literal('alert'), id: z.string(), txHash: z.string(), from: z.string(), to: z.string(), amountNative: z.string(), at: z.number(), reason: z.string() }),
  z.object({ type: z.literal('acknowledge'), id: z.string(), at: z.number(), reason: z.string().min(1) }),
  z.object({ type: z.literal('fault'), reason: z.string() }),
]);
type JournalRecord = z.infer<typeof recordSchema>;
type Reservation = z.infer<typeof expectationRecord>;
export type StreamAlert = Extract<JournalRecord, { type: 'alert' }> & { acknowledged?: { at: number; reason: string } };

/** Only the monitor process writes this journal. Acknowledgements follow fsync. */
export class StreamMonitor {
  config?: StreamConfiguration;
  readonly blocks = new Map<number, StreamBatch['blocks'][number]>();
  readonly receipts = new Map<string, StreamReceipt>();
  readonly expected = new Map<string, Reservation>();
  readonly alerts = new Map<string, StreamAlert>();
  private receivedAt = 0;
  private fault?: string;
  private readonly file: number;
  private pending = 0;
  constructor(directory: string, private readonly now: () => number = Date.now, private readonly sync: (fd: number) => void = fsyncSync) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, 'journal.jsonl');
    if (existsSync(filename)) {
      const raw = readFileSync(filename, 'utf8');
      if (raw && !raw.endsWith('\n')) throw new Error('Streams journal has an incomplete record; restore it before starting.');
      for (const line of raw.split('\n').filter(Boolean)) this.apply(recordSchema.parse(JSON.parse(line)));
    }
    this.file = openSync(filename, 'a', 0o600);
    // Persist the journal's directory entry too, before accepting reservations.
    const directoryFile = openSync(directory, 'r');
    try { fsyncSync(directoryFile); } finally { closeSync(directoryFile); }
    this.classify();
  }
  close(): void { closeSync(this.file); }

  private append(record: JournalRecord): void {
    if (this.fault) throw new Error(this.fault);
    try {
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(this.file, bytes, offset, bytes.length - offset);
      this.sync(this.file);
    } catch {
      this.fault = 'Streams storage failed; monitored spending is unavailable.';
      throw new Error(this.fault);
    }
    this.apply(record);
  }
  private apply(record: JournalRecord): void {
    switch (record.type) {
      case 'configure': this.config = record.config; break;
      case 'reserve': this.expected.set(record.expectation.id, record.expectation); break;
      case 'submitted': {
        const expected = this.expected.get(record.id);
        if (!expected) throw new Error('Submission has no recorded reservation');
        expected.txHash = record.txHash; break;
      }
      case 'batch':
        for (const block of record.batch.blocks) {
          this.blocks.set(block.number, block);
          for (const receipt of block.receipts) this.receipts.set(receipt.transactionHash, receipt);
        }
        this.receivedAt = Math.max(this.receivedAt, record.at); break;
      case 'alert': this.alerts.set(record.id, record); break;
      case 'acknowledge': {
        const alert = this.alerts.get(record.id);
        if (!alert) throw new Error('Acknowledgment has no recorded alert');
        alert.acknowledged = { at: record.at, reason: record.reason }; break;
      }
      case 'fault': this.fault = record.reason; break;
    }
  }
  configure(input: unknown): void {
    const config = configurationSchema.parse(input);
    if (this.config && JSON.stringify(this.config) !== JSON.stringify(config)) {
      throw new Error('Existing Stream configuration differs. Use a separate data directory for a different watchlist or range.');
    }
    if (!this.config) this.append({ type: 'configure', config });
  }
  ingest(input: unknown): void {
    const batch = batchSchema.parse(input);
    if (!this.config || batch.streamId !== this.config.streamId) throw new Error('Unexpected Stream ID or monitor not configured');
    const incoming = new Map<number, string>();
    const transactions = new Set<string>();
    for (const block of batch.blocks) {
      if (block.number < this.config.startBlock || incoming.has(block.number)) throw new Error('Unexpected or duplicate block range');
      incoming.set(block.number, block.hash);
      const previous = this.blocks.get(block.number);
      if (previous && JSON.stringify(previous) !== JSON.stringify(block)) {
        this.append({ type: 'fault', reason: `Conflicting finalized block ${block.number}; stop and investigate the Stream.` });
        throw new Error(this.fault);
      }
      for (const receipt of block.receipts) {
        if (receipt.blockHash !== block.hash || receipt.blockNumber !== block.number) throw new Error('Receipt does not belong to its block');
        if (transactions.has(receipt.transactionHash) || (this.receipts.has(receipt.transactionHash) && this.receipts.get(receipt.transactionHash)!.blockHash !== block.hash)) throw new Error('Duplicate or conflicting transaction receipt');
        transactions.add(receipt.transactionHash);
        const indices = receipt.logs.map(l => l.logIndex);
        if (new Set(indices).size !== indices.length) throw new Error('Duplicate receipt log index');
      }
    }
    // Arc has deterministic finality. Any conflicting parent is an integrity failure.
    const sorted = [...this.blocks.values(), ...batch.blocks].sort((a, b) => a.number - b.number);
    for (let i = 1; i < sorted.length; i++) {
      const before = sorted[i - 1]!, after = sorted[i]!;
      if (after.number === before.number + 1 && after.parentHash !== before.hash) {
        this.append({ type: 'fault', reason: 'Broken finalized block ancestry; stop and investigate the Stream.' });
        throw new Error(this.fault);
      }
    }
    if (batch.blocks.some(block => !this.blocks.has(block.number))) this.append({ type: 'batch', batch, at: this.now() });
    this.classify();
  }
  reserve(input: unknown): void {
    const expected = expectationSchema.parse(input);
    const prior = this.expected.get(expected.id);
    if (prior) {
      const { at: _at, fromBlock: _block, txHash: _hash, ...original } = prior;
      if (JSON.stringify(original) !== JSON.stringify(expected)) throw new Error('Outflow ID already used with different terms');
      this.check(); return;
    }
    this.check();
    if (expected.from !== this.config!.wallets.hot) throw new Error('Only the hot wallet may reserve spending');
    this.append({ type: 'reserve', expectation: { ...expected, at: this.now(), fromBlock: this.latestBlock() + 1 } });
  }
  submitted(id: string, txHash: TxHash): void {
    const expected = this.expected.get(id);
    if (!expected || (expected.txHash && expected.txHash !== txHash)) throw new Error('Unknown or conflicting outflow submission');
    this.append({ type: 'submitted', id, txHash });
    this.classify();
  }
  acknowledge(id: string, reason: string): void {
    if (!this.alerts.has(id) || !reason.trim()) throw new Error('An existing alert ID and an acknowledgment reason are required');
    this.append({ type: 'acknowledge', id, reason: reason.trim(), at: this.now() });
  }
  private latestBlock(): number { return [...this.blocks.keys()].reduce((max, n) => Math.max(max, n), (this.config?.startBlock ?? 0) - 1); }

  /** Evaluate only post-installation transfers; historical imports are evidence, not incidents. */
  private classify(): void {
    this.pending = 0;
    if (!this.config) return;
    const consumed = new Set<string>();
    for (const block of [...this.blocks.values()].sort((a, b) => a.number - b.number)) {
      if (block.number <= this.config.liveBoundary) continue;
      for (const receipt of block.receipts) {
        for (const movement of movements(receipt)) {
          if (![this.config.wallets.hot, this.config.wallets.vault].includes(movement.from)) continue;
          const id = `${receipt.transactionHash}:${movement.logIndex}`;
          const candidates = [...this.expected.values()].filter(e => !consumed.has(e.id) && block.number >= e.fromBlock && e.from === movement.from && e.to === movement.to && BigInt(e.amount) * NATIVE_SCALE === movement.amountNative);
          const matched = candidates.find(e => e.txHash === receipt.transactionHash || (e.nonce && receipt.logs.some(l => l.address === USDC_ADDRESS.toLowerCase() && l.topics[0] === AUTHORIZATION_USED && l.topics.length === 3 && topicAddress(l.topics[1]!) === e.from && l.topics[2] === e.nonce)));
          if (matched) { consumed.add(matched.id); continue; }
          if (candidates.some(e => !e.nonce && !e.txHash && this.now() - e.at <= PENDING_MS)) { this.pending++; continue; }
          if (!this.alerts.has(id)) this.append({
            type: 'alert', id, txHash: receipt.transactionHash, from: movement.from, to: movement.to,
            amountNative: movement.amountNative.toString(), at: this.now(),
            reason: movement.from === this.config.wallets.vault ? 'Unexpected vault outflow' : 'USDC outflow has no matching guarded authorization',
          });
        }
      }
    }
  }
  status() {
    this.classify();
    let coveredThrough = (this.config?.startBlock ?? 0) - 1;
    while (this.blocks.has(coveredThrough + 1)) coveredThrough++;
    const tip = this.blocks.get(coveredThrough);
    const active = [...this.alerts.values()].filter(a => !a.acknowledged);
    const caughtUp = !!this.config && coveredThrough >= this.config.liveBoundary;
    const fresh = !!tip && this.now() - tip.timestamp * 1000 <= MAX_AGE_MS && this.now() - this.receivedAt <= MAX_AGE_MS;
    const reason = this.fault ?? (active.length ? `Spending frozen: ${active[0]!.reason}` : !this.config ? 'Stream not configured' : !caughtUp ? 'Stream backfill is incomplete' : coveredThrough !== this.latestBlock() ? 'Stream coverage has a gap' : !fresh ? 'Stream is disconnected or more than 60 seconds behind' : this.pending ? 'A direct transfer is awaiting its transaction hash' : undefined);
    return {
      enabled: true, ready: !reason, frozen: active.length > 0, integrityError: !!this.fault, reason,
      streamId: this.config?.streamId, startBlock: this.config?.startBlock, liveBoundary: this.config?.liveBoundary,
      dataAgeSeconds: tip ? Math.max(0, Math.floor((this.now() - tip.timestamp * 1000) / 1000)) : null,
      coveredThrough, latestBlock: this.latestBlock(), lastDelivery: this.receivedAt || null, pending: this.pending,
      alerts: [...this.alerts.values()], recentTransfers: [...this.receipts.values()].sort((a, b) => b.blockNumber - a.blockNumber).slice(0, 20).flatMap(r => movements(r).map(m => ({ txHash: r.transactionHash, block: r.blockNumber, from: m.from, to: m.to, amountNative: m.amountNative.toString() }))),
    };
  }
  check(): void {
    const status = this.status();
    if (!status.ready) throw new Error(status.reason);
  }
}
