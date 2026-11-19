import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision } from '../types.js';

/** One payment decision, allowed or denied, as written to the audit log. Amounts in decimal USDC. */
export interface AuditEntry {
  at: string;
  /** 'off' for the unguarded baseline, which approves everything. */
  guard: 'on' | 'off';
  /** send: a quoted merchant payment; api: a paid HTTP request; receive: a payment made to us; market: a prediction market order. */
  kind: 'send' | 'api' | 'receive' | 'market';
  allowed: boolean;
  rule: string;
  reason: string;
  resource?: string;
  amountUsdc?: string;
  payTo?: string;
  network?: string;
  /** The onchain transaction, when there is one. */
  txHash?: string;
  /** Gateway's transfer id for a batched nanopayment. */
  settlementRef?: string;
  /** A prediction market order: the venue's order id. */
  orderRef?: string;
}

/** Append-only: entries are added, never changed or removed. */
export interface AuditLog {
  append(entry: AuditEntry): void;
}

/** One JSON object per line. Each write is a single append, so nothing earlier is rewritten. */
export class JsonlAuditLog implements AuditLog {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(entry: AuditEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    this.entries.push(Object.freeze({ ...entry }));
  }
}

/** What a decision was about, for its audit entry. */
export type AuditContext = Pick<AuditEntry, 'kind'> & Partial<Pick<AuditEntry, 'resource' | 'amountUsdc' | 'payTo' | 'network'>>;

export function auditEntry(decision: Decision, context: AuditContext, guard: 'on' | 'off', at = new Date()): AuditEntry {
  return {
    at: at.toISOString(),
    guard,
    ...context,
    allowed: decision.allowed,
    rule: decision.check,
    reason: decision.reason,
    ...(decision.txHash ? { txHash: decision.txHash } : decision.receivedTx ? { txHash: decision.receivedTx } : {}),
    ...(decision.settlementRef ? { settlementRef: decision.settlementRef } : {}),
    ...(decision.orderRef ? { orderRef: decision.orderRef } : {}),
  };
}

/** Writes an entry, never letting a failing log change a payment's outcome. */
export function safeAppend(log: AuditLog | undefined, entry: AuditEntry): void {
  try {
    log?.append(entry);
  } catch {
    // An audit write that fails is reported by the log itself; the decision stands.
  }
}
