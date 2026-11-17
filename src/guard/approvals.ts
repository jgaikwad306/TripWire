import { randomUUID } from 'node:crypto';
import type { Address, PaymentIntent, Usdc } from '../types.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'used' | 'expired';

/**
 * One request for the owner to approve a payment. It is tied to a single recorded quote,
 * so what the owner sees (resource, recipient, amount) is exactly what would be paid.
 */
export interface Approval {
  readonly id: string;
  readonly intentId: string;
  readonly merchantUrl: string;
  readonly item: string;
  readonly payTo: Address;
  readonly amount: Usdc;
  readonly createdAt: number;
  /**
   * After this a pending request can no longer be approved, and an approval can no longer
   * be used. Approving restarts the clock, so an approval gets the full time to be used.
   */
  readonly expiresAt: number;
  readonly status: ApprovalStatus;
}

const DECISION_POLL_MS = 100;
/**
 * How many requests may wait for the owner at once. A hijacked agent can ask for as many
 * quotes as it likes; it must not be able to bury the owner in requests.
 */
export const MAX_PENDING_APPROVALS = 3;

/** Thrown when the owner acts on a request that does not exist. */
export class UnknownApprovalError extends Error {}
/** Thrown when the owner acts on a request that is no longer waiting for a decision. */
export class ApprovalClosedError extends Error {}

/**
 * The owner's side of approvals. The guard files requests here and checks them before
 * paying; only the owner's console calls `approve` and `deny`. Nothing here is reachable
 * from the agent's tools.
 */
export class ApprovalDesk {
  private approvals: ReadonlyMap<string, Approval> = new Map();

  constructor(private readonly now: () => number = Date.now) {}

  /** Files a request for this quote, or returns the one already filed for it. */
  request(intent: PaymentIntent, ttlMs: number): Approval {
    const existing = this.forIntent(intent.id);
    if (existing) return existing;
    const createdAt = this.now();
    return this.save({
      id: `approval-${randomUUID()}`,
      intentId: intent.id,
      merchantUrl: intent.merchantUrl,
      item: intent.item,
      payTo: intent.payTo,
      amount: intent.amount,
      createdAt,
      expiresAt: createdAt + ttlMs,
      status: 'pending',
    });
  }

  forIntent(intentId: string): Approval | undefined {
    return this.list().find((approval) => approval.intentId === intentId);
  }

  /** Every request, oldest first, with expiry applied. */
  list(): Approval[] {
    return [...this.approvals.values()].map((approval) => this.current(approval));
  }

  pending(): Approval[] {
    return this.list().filter((approval) => approval.status === 'pending');
  }

  approve(id: string): Approval {
    return this.decide(id, 'approved');
  }

  deny(id: string): Approval {
    return this.decide(id, 'denied');
  }

  /** Uses an approval for its one payment. False unless it is approved and still in date. */
  consume(id: string): boolean {
    const approval = this.find(id);
    if (!approval || approval.status !== 'approved') return false;
    this.save({ ...approval, status: 'used' });
    return true;
  }

  /** Resolves once the request is decided or has expired, or when the time is up. */
  async waitForDecision(id: string, timeoutMs: number): Promise<Approval | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const approval = this.find(id);
      if (!approval || approval.status !== 'pending' || Date.now() >= deadline) return approval;
      await new Promise((resolve) => setTimeout(resolve, DECISION_POLL_MS));
    }
  }

  private decide(id: string, status: 'approved' | 'denied'): Approval {
    const approval = this.find(id);
    if (!approval) throw new UnknownApprovalError(`No approval request with id ${id}.`);
    if (approval.status !== 'pending') {
      throw new ApprovalClosedError(`This request is already ${approval.status}, so it cannot be ${status}.`);
    }
    // An approval is usable for as long as the request was open for, counted from now:
    // approving at the last moment must not leave the payment a second to go through.
    const usableFor = approval.expiresAt - approval.createdAt;
    return this.save({ ...approval, status, ...(status === 'approved' ? { expiresAt: this.now() + usableFor } : {}) });
  }

  /** Is there room to ask about this quote? True if it was already asked about. */
  hasRoomFor(intentId: string): boolean {
    return this.forIntent(intentId) !== undefined || this.pending().length < MAX_PENDING_APPROVALS;
  }

  private find(id: string): Approval | undefined {
    const stored = this.approvals.get(id);
    return stored ? this.current(stored) : undefined;
  }

  /** A request or approval left past its time counts as expired, whatever is stored. */
  private current(approval: Approval): Approval {
    const open = approval.status === 'pending' || approval.status === 'approved';
    return open && this.now() > approval.expiresAt ? Object.freeze({ ...approval, status: 'expired' }) : approval;
  }

  private save(approval: Approval): Approval {
    const frozen = Object.freeze({ ...approval });
    this.approvals = new Map(this.approvals).set(frozen.id, frozen);
    return frozen;
  }
}
