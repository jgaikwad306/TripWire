import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, FakeLedger } from '../../src/fakes/index.js';
import { CHECK } from '../../src/guard/checks.js';
import { createGuard, defaultPolicy } from '../../src/guard/index.js';
import { MemoryGuardStore } from '../../src/guard/store.js';
import type { Quote } from '../../src/types.js';
import { LocalFacilitator } from '../../src/x402/facilitator.js';
import { ARC_NETWORK, HEADER, decode, encode, eip3009Of, exactRequirements, nonceFor, signPayment, type PaymentPayload } from '../../src/x402/protocol.js';

const PRICE = parseUsdc('0.5');
const MERCHANT_URL = 'http://merchant.test';
const quote: Quote = {
  merchantUrl: MERCHANT_URL,
  item: 'report',
  payTo: FAKE_ADDRESSES.merchant,
  amount: PRICE,
  requirements: exactRequirements(FAKE_ADDRESSES.merchant, PRICE),
};

type Behaviour = 'settle' | 'lie' | 'refuse' | 'down' | 'settle-silently';

/** A merchant whose behaviour each test chooses, settling through the official facilitator. */
function world(behaviour: { current: Behaviour }, opts: { unixNow?: () => number } = {}) {
  const ledger = new FakeLedger({ hot: parseUsdc('10') });
  const facilitator = new LocalFacilitator(ledger.facilitatorSigner());
  const presented: PaymentPayload[] = [];
  const merchant: typeof fetch = async (_url, init) => {
    const payload = decode.signature(new Headers(init?.headers).get(HEADER.signature)!);
    presented.push(payload);
    const json = (status: number, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify({ delivered: status === 200 }), { status, headers });
    switch (behaviour.current) {
      case 'down':
        throw new Error('connect ECONNREFUSED');
      case 'refuse':
        return json(402);
      case 'lie':
        // Claims a settlement that never happened.
        return json(200, { [HEADER.response]: encode.response({ success: true, transaction: `0x${'99'.repeat(32)}`, network: ARC_NETWORK }) });
      case 'settle-silently': {
        await facilitator.settle(payload, payload.accepted);
        return json(402);
      }
      default: {
        const settled = await facilitator.settle(payload, payload.accepted);
        return json(settled.success ? 200 : 402, { [HEADER.response]: encode.response(settled) });
      }
    }
  };
  const guard = createGuard({
    wallet: ledger,
    chain: ledger,
    store: new MemoryGuardStore(),
    fetchQuote: async () => quote,
    fetchImpl: merchant,
    policy: defaultPolicy(ledger, { loopMaxRepeats: 5 }),
    ...opts,
  });
  const pay = async () => {
    const intent = await guard.getQuote(MERCHANT_URL, 'report');
    return guard.requestPayment({ intentId: intent.id, payTo: intent.payTo, amount: intent.amount, reason: '' });
  };
  return { ledger, guard, presented, pay, merchantBalance: () => ledger.getBalance('merchant') };
}

describe('guard paying over x402', () => {
  it('signs an EIP-3009 authorization from the hot wallet for exactly the quoted terms', async () => {
    const w = world({ current: 'settle' });
    const decision = await w.pay();

    expect(decision).toMatchObject({ allowed: true, check: CHECK.ok, merchantResponse: { status: 200 } });
    const signed = eip3009Of(w.presented[0]!)!;
    expect(signed.authorization).toMatchObject({ from: FAKE_ADDRESSES.hot, to: FAKE_ADDRESSES.merchant, value: PRICE.toString() });
    expect(w.presented[0]!.accepted).toEqual(quote.requirements);
    expect(await w.merchantBalance()).toBe(PRICE);
    expect((await w.ledger.authorizationUsed(FAKE_ADDRESSES.hot, signed.authorization.nonce)).txHash).toBe(decision.txHash);
  });

  it('does not take a merchant at its word: a claimed settlement that is not onchain is not "paid"', async () => {
    const w = world({ current: 'lie' });
    const decision = await w.pay();

    expect(decision).toMatchObject({ allowed: false, check: CHECK.wallet });
    expect(decision.reason).toMatch(/outcome is unknown/);
    expect(decision.txHash).toBeUndefined();
  });

  it('finds a payment the merchant settled but did not admit to, from the chain', async () => {
    const w = world({ current: 'settle-silently' });
    const decision = await w.pay();

    expect(decision.allowed).toBe(true);
    expect(decision.txHash).toMatch(/^0x/);
    expect(await w.merchantBalance()).toBe(PRICE);
  });

  it('presents the same authorization again for an unfinished payment, so it can never pay twice', async () => {
    const behaviour = { current: 'down' as Behaviour };
    const w = world(behaviour);

    const first = await w.pay();
    expect(first).toMatchObject({ allowed: false, check: CHECK.wallet });
    // Unsettled but still valid: the order is blocked rather than paid a second time.
    expect(await w.pay()).toMatchObject({ allowed: false, check: CHECK.reconcile });

    behaviour.current = 'settle';
    const recovered = await w.pay();

    expect(recovered).toMatchObject({ allowed: true });
    expect(recovered.reason).toMatch(/recovered/);
    const nonces = new Set(w.presented.map((p) => eip3009Of(p)!.authorization.nonce));
    expect(nonces.size).toBe(1);
    expect(await w.merchantBalance()).toBe(PRICE);
  });

  it('releases an unfinished payment once its authorization has expired unused', async () => {
    let now = Math.floor(Date.now() / 1000);
    const behaviour = { current: 'refuse' as Behaviour };
    const w = world(behaviour, { unixNow: () => now });

    expect((await w.pay()).allowed).toBe(false);
    now += 3600;
    behaviour.current = 'settle';
    // The old authorization can never settle now, so a fresh payment for the order is made.
    const decision = await w.pay();

    expect(decision.allowed).toBe(true);
    expect(decision.reason).not.toMatch(/recovered/);
    expect(new Set(w.presented.map((p) => eip3009Of(p)!.authorization.nonce)).size).toBe(2);
  });

  it('refuses a quote whose x402 terms disagree with its price', async () => {
    const ledger = new FakeLedger();
    const guard = createGuard({
      wallet: ledger,
      chain: ledger,
      fetchQuote: async () => ({ ...quote, requirements: exactRequirements(FAKE_ADDRESSES.merchant, PRICE * 2n) }),
      policy: defaultPolicy(ledger),
    });
    await expect(guard.getQuote(MERCHANT_URL, 'report')).rejects.toThrow(/disagree/);
  });
});

describe('guard receiving over x402', () => {
  it('accepts a payment the facilitator settled even when its answer was lost, from the chain', async () => {
    const ledger = new FakeLedger({ hot: parseUsdc('10') });
    const real = new LocalFacilitator(ledger.facilitatorSigner());
    // Settles, then times out before answering: what Circle did once on Arc.
    const timingOut = {
      name: 'flaky',
      verify: real.verify.bind(real),
      settle: async (...args: Parameters<typeof real.settle>) => {
        await real.settle(...args);
        throw new Error('The operation was aborted due to timeout');
      },
    };
    const guard = createGuard({ wallet: ledger, chain: ledger, facilitator: timingOut, fetchQuote: async () => quote, policy: defaultPolicy(ledger) });
    const terms = exactRequirements(FAKE_ADDRESSES.merchant, PRICE);
    const payload = await signPayment({
      sign: (data) => ledger.signTypedData('hot', data),
      from: FAKE_ADDRESSES.hot,
      requirements: terms,
      nonce: nonceFor('lost-answer'),
      validBefore: Math.floor(Date.now() / 1000) + 60,
    });

    const decision = await guard.acceptPayment({ orderId: 'o', payload, requirements: terms });

    expect(decision).toMatchObject({ allowed: true, check: CHECK.ok });
    expect(decision.receivedTx).toMatch(/^0x/);
  });

  it('still refuses when the facilitator fails and nothing settled', async () => {
    const ledger = new FakeLedger({ hot: parseUsdc('10') });
    const real = new LocalFacilitator(ledger.facilitatorSigner());
    const broken = { name: 'broken', verify: real.verify.bind(real), settle: async () => Promise.reject(new Error('503')) };
    const guard = createGuard({ wallet: ledger, chain: ledger, facilitator: broken, fetchQuote: async () => quote, policy: defaultPolicy(ledger) });
    const terms = exactRequirements(FAKE_ADDRESSES.merchant, PRICE);
    const payload = await signPayment({
      sign: (data) => ledger.signTypedData('hot', data),
      from: FAKE_ADDRESSES.hot,
      requirements: terms,
      nonce: nonceFor('no-settlement'),
      validBefore: Math.floor(Date.now() / 1000) + 60,
    });

    expect(await guard.acceptPayment({ orderId: 'o', payload, requirements: terms })).toMatchObject({
      allowed: false,
      check: CHECK.facilitator,
    });
  });
});
