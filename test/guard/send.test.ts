import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { CHECK } from '../../src/guard/checks.js';
import type { Spend } from '../../src/guard/intents.js';
import { evaluateSend, type SendState } from '../../src/guard/send.js';
import type { PaymentRequest } from '../../src/types.js';
import { ATTACKER, MERCHANT, intentWith, policyWith } from './helpers.js';

const NOW = 1_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const requestFor = (intent = intentWith(), overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
  intentId: intent.id,
  payTo: intent.payTo,
  amount: intent.amount,
  reason: 'Buying a report',
  ...overrides,
});

const stateWith = (overrides: Partial<SendState> = {}): SendState => ({
  intent: intentWith(),
  spends: [],
  hotBalance: parseUsdc('10'),
  ...overrides,
});

const spend = (amount: string, agoMs: number, payTo = MERCHANT): Spend => ({ payTo, amount: parseUsdc(amount), at: NOW - agoMs });

describe('evaluateSend', () => {
  it('allows a payment that matches a recorded intent and policy', () => {
    const decision = evaluateSend(requestFor(), stateWith(), policyWith(), NOW);
    expect(decision).toMatchObject({ allowed: true, check: CHECK.ok });
  });

  describe('intent-match', () => {
    it('denies when the intent id is unknown', () => {
      const decision = evaluateSend(requestFor(), stateWith({ intent: undefined }), policyWith(), NOW);
      expect(decision).toMatchObject({ allowed: false, check: CHECK.intentMatch });
    });

    it('denies when the requested payTo differs from the intent', () => {
      const decision = evaluateSend(requestFor(intentWith(), { payTo: ATTACKER }), stateWith(), policyWith(), NOW);
      expect(decision).toMatchObject({ allowed: false, check: CHECK.intentMatch });
    });

    it('denies when the requested amount differs from the intent', () => {
      const req = requestFor(intentWith(), { amount: parseUsdc('5') });
      expect(evaluateSend(req, stateWith(), policyWith(), NOW)).toMatchObject({ allowed: false, check: CHECK.intentMatch });
    });

    it('denies malformed request fields instead of throwing', () => {
      const req = { intentId: 'intent-1', payTo: 42, amount: '0.5', reason: '' } as unknown as PaymentRequest;
      expect(evaluateSend(req, stateWith(), policyWith(), NOW)).toMatchObject({ allowed: false, check: CHECK.intentMatch });
    });

    it('treats addresses case-insensitively', () => {
      const req = requestFor(intentWith(), { payTo: MERCHANT.toUpperCase().replace('0X', '0x') as typeof MERCHANT });
      expect(evaluateSend(req, stateWith(), policyWith(), NOW).allowed).toBe(true);
    });
  });

  describe('allowlist', () => {
    it('denies an intent whose payTo is not allowlisted', () => {
      const intent = intentWith({ payTo: ATTACKER });
      const decision = evaluateSend(requestFor(intent), stateWith({ intent }), policyWith(), NOW);
      expect(decision).toMatchObject({ allowed: false, check: CHECK.allowlist });
    });

    it('allows the same payee once the owner allowlists it', () => {
      const intent = intentWith({ payTo: ATTACKER });
      const policy = policyWith({ allowlist: [MERCHANT, ATTACKER] });
      expect(evaluateSend(requestFor(intent), stateWith({ intent }), policy, NOW).allowed).toBe(true);
    });
  });

  describe('price', () => {
    const policy = policyWith({ expectedPrices: { report: parseUsdc('0.5') } });

    it('denies a quote far above the reference price', () => {
      const intent = intentWith({ amount: parseUsdc('5') });
      const decision = evaluateSend(requestFor(intent), stateWith({ intent }), policy, NOW);
      expect(decision).toMatchObject({ allowed: false, check: CHECK.price });
    });

    it('allows a quote within tolerance of the reference price', () => {
      const intent = intentWith({ amount: parseUsdc('0.525') });
      expect(evaluateSend(requestFor(intent), stateWith({ intent }), policy, NOW).allowed).toBe(true);
    });

    it('denies a quote just over the tolerance', () => {
      const intent = intentWith({ amount: parseUsdc('0.525001') });
      expect(evaluateSend(requestFor(intent), stateWith({ intent }), policy, NOW).check).toBe(CHECK.price);
    });

    it('skips the check for items without a reference price', () => {
      const intent = intentWith({ item: 'dataset', amount: parseUsdc('2') });
      expect(evaluateSend(requestFor(intent), stateWith({ intent }), policy, NOW).allowed).toBe(true);
    });
  });

  describe('limits', () => {
    it('denies an amount over the per-transaction cap', () => {
      const intent = intentWith({ amount: parseUsdc('5.000001') });
      const decision = evaluateSend(requestFor(intent), stateWith({ intent }), policyWith(), NOW);
      expect(decision).toMatchObject({ allowed: false, check: CHECK.limits });
    });

    it('allows an amount exactly at the per-transaction cap', () => {
      const intent = intentWith({ amount: parseUsdc('5') });
      expect(evaluateSend(requestFor(intent), stateWith({ intent }), policyWith(), NOW).allowed).toBe(true);
    });

    it('denies when the rolling 24h spend would exceed the daily cap', () => {
      const spends = [spend('4', HOUR), spend('3', 2 * HOUR)];
      const policy = policyWith({ dailyCap: parseUsdc('7.4') });
      const decision = evaluateSend(requestFor(), stateWith({ spends }), policy, NOW);
      expect(decision).toMatchObject({ allowed: false, check: CHECK.limits });
    });

    it('ignores spends older than 24 hours for the daily cap', () => {
      const spends = [spend('4', 25 * HOUR), spend('3', 26 * HOUR)];
      const policy = policyWith({ dailyCap: parseUsdc('7.4') });
      expect(evaluateSend(requestFor(), stateWith({ spends }), policy, NOW).allowed).toBe(true);
    });

    it('denies when the hot balance cannot cover the amount', () => {
      const decision = evaluateSend(requestFor(), stateWith({ hotBalance: parseUsdc('0.4') }), policyWith(), NOW);
      expect(decision).toMatchObject({ allowed: false, check: CHECK.limits });
    });
  });

  describe('loop', () => {
    it('denies an intent that was already paid', () => {
      const intent = intentWith({ status: 'paid' });
      const decision = evaluateSend(requestFor(intent), stateWith({ intent }), policyWith(), NOW);
      expect(decision).toMatchObject({ allowed: false, check: CHECK.loop });
    });

    it('allows a second identical purchase inside the window', () => {
      const spends = [spend('0.5', MINUTE)];
      expect(evaluateSend(requestFor(), stateWith({ spends }), policyWith(), NOW).allowed).toBe(true);
    });

    it('denies a third identical purchase inside the window', () => {
      const spends = [spend('0.5', MINUTE), spend('0.5', 2 * MINUTE)];
      const decision = evaluateSend(requestFor(), stateWith({ spends }), policyWith(), NOW);
      expect(decision).toMatchObject({ allowed: false, check: CHECK.loop });
    });

    it('allows the purchase again once earlier ones fall outside the window', () => {
      const spends = [spend('0.5', 11 * MINUTE), spend('0.5', 12 * MINUTE)];
      expect(evaluateSend(requestFor(), stateWith({ spends }), policyWith(), NOW).allowed).toBe(true);
    });

    it('does not count payments of a different amount or payee', () => {
      const spends = [spend('0.6', MINUTE), spend('0.5', MINUTE, ATTACKER)];
      expect(evaluateSend(requestFor(), stateWith({ spends }), policyWith(), NOW).allowed).toBe(true);
    });
  });
});
