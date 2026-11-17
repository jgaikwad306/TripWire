import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Address, PaymentIntent, TxHash, Usdc } from '../types.js';
import { errorMessage } from './checks.js';

/**
 * How a payment stands:
 *  - reserved: written down before the transfer was attempted; nothing is known yet
 *  - sent:     the wallet confirmed it, and `txHash` is the transaction
 *  - failed:   the wallet definitely did not send it; it no longer counts against limits
 *  - unknown:  the attempt ended in an error after which the money may or may not have moved
 */
export type PaymentState = 'reserved' | 'sent' | 'failed' | 'unknown';

/** One payment the guard decided to make. Kept so limits and outcomes survive a restart. */
export interface PaymentRecord {
  /** Idempotency key the transfer is sent under. Re-sending with it never pays twice. */
  readonly key: string;
  readonly intentId: string;
  readonly item: string;
  readonly payTo: Address;
  readonly amount: Usdc;
  readonly at: number;
  readonly state: PaymentState;
  readonly txHash?: TxHash;
  /** Has the transaction hash been handed to whoever asked for the payment? */
  readonly delivered: boolean;
  /** What the wallet said when the last attempt did not end in a confirmed transfer. */
  readonly error?: string;
}

/** Everything the guard needs to carry on after a restart. */
export interface GuardState {
  readonly intents: readonly PaymentIntent[];
  readonly payments: readonly PaymentRecord[];
  readonly usedReceipts: readonly string[];
}

export const EMPTY_STATE: GuardState = Object.freeze({ intents: [], payments: [], usedReceipts: [] });

export interface GuardStore {
  load(): GuardState;
  save(state: GuardState): void;
}

/** Forgets everything when the process ends. The default, and what each red-team scenario uses. */
export class MemoryGuardStore implements GuardStore {
  private state: GuardState = EMPTY_STATE;

  load(): GuardState {
    return this.state;
  }

  save(state: GuardState): void {
    this.state = state;
  }
}

const FILE_VERSION = 1;

/** Amounts are bigint in memory and base-unit decimal strings in the file. */
const usdc = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => BigInt(value));
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value as Address);

const fileSchema = z.object({
  version: z.literal(FILE_VERSION),
  intents: z.array(
    z.object({
      id: z.string(),
      merchantUrl: z.string(),
      item: z.string(),
      payTo: address,
      amount: usdc,
      description: z.string().optional(),
      createdAt: z.number(),
      status: z.enum(['open', 'paid']),
    }),
  ),
  payments: z.array(
    z.object({
      key: z.string(),
      intentId: z.string(),
      item: z.string(),
      payTo: address,
      amount: usdc,
      at: z.number(),
      state: z.enum(['reserved', 'sent', 'failed', 'unknown']),
      txHash: z
        .string()
        .regex(/^0x[0-9a-fA-F]+$/)
        .transform((value) => value as TxHash)
        .optional(),
      delivered: z.boolean(),
      error: z.string().optional(),
    }),
  ),
  usedReceipts: z.array(z.string()),
});

/** Makes the rename itself durable. Not every platform can flush a directory; those skip it. */
function flushDirectory(path: string): void {
  try {
    const directory = openSync(path, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // The file's contents are already flushed; only the rename's durability is at stake.
  }
}

/** Drops keys whose value is undefined, so optional fields are absent rather than present-but-empty. */
const compact = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

/**
 * Guard state in one JSON file. Every save writes a temporary file and renames it over
 * the old one, so a crash mid-write leaves the previous state intact. A file that cannot
 * be read stops the guard from starting: beginning empty would forget what was spent.
 */
export class JsonFileGuardStore implements GuardStore {
  constructor(private readonly path: string) {}

  load(): GuardState {
    if (!existsSync(this.path)) return EMPTY_STATE;
    try {
      const parsed = fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
      return {
        intents: parsed.intents.map((intent) => compact(intent)),
        payments: parsed.payments.map((payment) => compact(payment)),
        usedReceipts: parsed.usedReceipts,
      };
    } catch (err) {
      throw new Error(`Guard state file ${this.path} is unreadable or corrupt: ${errorMessage(err)}`);
    }
  }

  save(state: GuardState): void {
    const text = JSON.stringify(
      { version: FILE_VERSION, ...state },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    );
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    // Flushed to disk before the rename, so the file a restart finds is whole and current
    // even after a power loss, not only after a process crash.
    const file = openSync(temporary, 'w');
    try {
      writeSync(file, text);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
    flushDirectory(dirname(this.path));
  }
}
