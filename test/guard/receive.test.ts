import { describe, expect, it } from 'vitest';
import { USDC_ADDRESS, parseUsdc } from '../../src/constants.js';
import { FAKE_TOKEN_ADDRESS } from '../../src/fakes/index.js';
import { CHECK } from '../../src/guard/checks.js';
import { evaluateReceipt } from '../../src/guard/receive.js';
import type { ReceiptRequest, TokenTransfer, TxInfo } from '../../src/types.js';
import { ATTACKER, CUSTOMER, MERCHANT, policyWith } from './helpers.js';

const TX_HASH = `0x${'ab'.repeat(32)}` as const;
const PRICE = parseUsdc('2');

const request = (overrides: Partial<ReceiptRequest> = {}): ReceiptRequest => ({
  orderId: 'order-1',
  txHash: TX_HASH,
  expectedTo: MERCHANT,
  expectedAmount: PRICE,
  ...overrides,
});

const usdcTransfer = (overrides: Partial<TokenTransfer> = {}): TokenTransfer => ({
  token: USDC_ADDRESS,
  from: CUSTOMER,
  to: MERCHANT,
  value: PRICE,
  ...overrides,
});

const txWith = (overrides: Partial<TxInfo> = {}): TxInfo => ({
  txHash: TX_HASH,
  status: 'success',
  confirmations: 1,
  transfers: [usdcTransfer()],
  ...overrides,
});

const policy = policyWith();

describe('evaluateReceipt', () => {
  it('accepts a confirmed USDC payment of the right amount to our address', () => {
    expect(evaluateReceipt(request(), txWith(), false, policy)).toMatchObject({ allowed: true, check: CHECK.ok });
  });

  it('accepts an overpayment', () => {
    const tx = txWith({ transfers: [usdcTransfer({ value: PRICE + 1n })] });
    expect(evaluateReceipt(request(), tx, false, policy).allowed).toBe(true);
  });

  it('rejects when the expected recipient is not one of our addresses', () => {
    const decision = evaluateReceipt(request({ expectedTo: ATTACKER }), txWith(), false, policy);
    expect(decision).toMatchObject({ allowed: false, check: CHECK.recipient });
  });

  it('rejects a non-positive expected amount', () => {
    const decision = evaluateReceipt(request({ expectedAmount: 0n }), txWith(), false, policy);
    expect(decision).toMatchObject({ allowed: false, check: CHECK.amount });
  });

  it('rejects a transaction that does not exist', () => {
    expect(evaluateReceipt(request(), null, false, policy)).toMatchObject({ allowed: false, check: CHECK.txExists });
  });

  it('rejects a reverted transaction', () => {
    const decision = evaluateReceipt(request(), txWith({ status: 'reverted' }), false, policy);
    expect(decision).toMatchObject({ allowed: false, check: CHECK.txStatus });
  });

  it('rejects a transaction without enough confirmations', () => {
    const decision = evaluateReceipt(request(), txWith({ confirmations: 0 }), false, policy);
    expect(decision).toMatchObject({ allowed: false, check: CHECK.txStatus });
  });

  it('rejects a counterfeit token even with the right recipient and amount', () => {
    const tx = txWith({ transfers: [usdcTransfer({ token: FAKE_TOKEN_ADDRESS })] });
    expect(evaluateReceipt(request(), tx, false, policy)).toMatchObject({ allowed: false, check: CHECK.token });
  });

  it('rejects real USDC that went to someone else', () => {
    const tx = txWith({ transfers: [usdcTransfer({ to: ATTACKER })] });
    expect(evaluateReceipt(request(), tx, false, policy)).toMatchObject({ allowed: false, check: CHECK.recipient });
  });

  it('rejects an underpayment', () => {
    const tx = txWith({ transfers: [usdcTransfer({ value: PRICE - 1n })] });
    expect(evaluateReceipt(request(), tx, false, policy)).toMatchObject({ allowed: false, check: CHECK.amount });
  });

  it('does not let a counterfeit transfer top up a real underpayment', () => {
    const tx = txWith({
      transfers: [usdcTransfer({ value: PRICE / 2n }), usdcTransfer({ token: FAKE_TOKEN_ADDRESS, value: PRICE })],
    });
    expect(evaluateReceipt(request(), tx, false, policy)).toMatchObject({ allowed: false, check: CHECK.amount });
  });

  it('rejects a transaction hash that was already used', () => {
    expect(evaluateReceipt(request(), txWith(), true, policy)).toMatchObject({ allowed: false, check: CHECK.replay });
  });
});
