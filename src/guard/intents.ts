import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Address, PaymentIntent, Quote, Usdc } from '../types.js';
import { errorMessage } from './checks.js';

/** One payment the guard actually sent. Feeds the daily cap and loop detection. */
export interface Spend {
  readonly payTo: Address;
  readonly amount: Usdc;
  readonly at: number;
}

/** Quotes the guard fetched itself. A payment must reference one of these. */
export class IntentStore {
  private intents: ReadonlyMap<string, PaymentIntent>;

  /** Starts from intents recorded in an earlier session, if any. */
  constructor(initial: readonly PaymentIntent[] = []) {
    this.intents = new Map(initial.map((intent) => [intent.id, Object.freeze({ ...intent })]));
  }

  all(): PaymentIntent[] {
    return [...this.intents.values()];
  }

  /** Makes an intent payable again, after a transfer for it definitely did not happen. */
  reopen(id: string): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    this.intents = new Map(this.intents).set(id, Object.freeze({ ...intent, status: 'open' }));
  }

  record(quote: Quote, now: number): PaymentIntent {
    const intent: PaymentIntent = Object.freeze({ ...quote, id: `intent-${randomUUID()}`, createdAt: now, status: 'open' });
    this.intents = new Map(this.intents).set(intent.id, intent);
    // Hand out a copy: callers must not be able to change what the guard recorded.
    return { ...intent };
  }

  get(id: string): PaymentIntent | undefined {
    return this.intents.get(id);
  }

  markPaid(id: string): void {
    const intent = this.intents.get(id);
    if (!intent) return;
    this.intents = new Map(this.intents).set(id, Object.freeze({ ...intent, status: 'paid' }));
  }
}

/**
 * Payments already accepted, so none pays for two orders. Entries are transaction hashes
 * (older receipts) or `x402:<payer>:<nonce>` for x402 authorizations.
 */
export interface ReplayLedger {
  has(key: string): boolean;
  add(key: string): void;
}

const normalize = (key: string): string => key.toLowerCase();

export class MemoryReplayLedger implements ReplayLedger {
  private used: ReadonlySet<string>;

  constructor(initial: readonly string[] = []) {
    this.used = new Set(initial.map((hash) => hash.toLowerCase()));
  }

  all(): string[] {
    return [...this.used];
  }

  has(key: string): boolean {
    return this.used.has(normalize(key));
  }

  add(key: string): void {
    this.used = new Set(this.used).add(normalize(key));
  }
}

const ledgerFileSchema = z.array(z.string());

/** Replay ledger that survives restarts. The file is a JSON array of transaction hashes. */
export class JsonFileReplayLedger implements ReplayLedger {
  private used: ReadonlySet<string>;

  constructor(private readonly path: string) {
    this.used = new Set(existsSync(path) ? readLedgerFile(path) : []);
  }

  has(key: string): boolean {
    return this.used.has(normalize(key));
  }

  add(key: string): void {
    const next = new Set(this.used).add(normalize(key));
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify([...next], null, 2));
    this.used = next;
  }
}

/** Fails loudly on a corrupt file: starting empty would let old payments be replayed. */
function readLedgerFile(path: string): string[] {
  try {
    return ledgerFileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).map((hash) => hash.toLowerCase());
  } catch (err) {
    throw new Error(`Replay ledger file ${path} is unreadable or corrupt: ${errorMessage(err)}`);
  }
}
