import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { httpQuoteFetcher } from '../../src/merchant/quote.js';
import { startMerchant, type MockMerchant } from '../../src/merchant/server.js';
import type { Decision, ReceiptRequest } from '../../src/types.js';

const PAY_TO = '0x00000000000000000000000000000000000000a3';
const ATTACKER = '0x00000000000000000000000000000000000000a4';
const TX = `0x${'ab'.repeat(32)}`;

let merchant: MockMerchant;
let verify: ((req: ReceiptRequest) => Promise<Decision>) | undefined;

beforeAll(async () => {
  merchant = await startMerchant({
    payTo: PAY_TO,
    attacker: ATTACKER,
    prices: { report: parseUsdc('0.5') },
    verifyPayment: (req) => (verify ? verify(req) : Promise.resolve({ allowed: true, check: 'ok', reason: '' })),
  });
});
afterAll(() => merchant.close());
beforeEach(() => {
  merchant.reset();
  verify = undefined;
});

const buy = async (body: unknown) => {
  const res = await fetch(`${merchant.url}/buy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
};

describe('mock merchant: honest', () => {
  it('quotes, asks for payment, then delivers on proof', async () => {
    const quote = await httpQuoteFetcher(merchant.url, 'report');
    expect(quote).toMatchObject({ item: 'report', payTo: PAY_TO, amount: parseUsdc('0.5') });

    const ask = await buy({ item: 'report' });
    expect(ask.status).toBe(402);
    expect(ask.body).toMatchObject({ error: 'payment_required', payTo: PAY_TO, amount: '500000' });

    const done = await buy({ item: 'report', txHash: TX });
    expect(done.status).toBe(200);
    expect(merchant.deliveries()).toEqual([{ orderId: 'order-1', item: 'report', txHash: TX }]);
    expect(merchant.buyAttempts()).toBe(2);
  });

  it('asks the verifier before delivering and refuses when it says no', async () => {
    let seen: ReceiptRequest | undefined;
    verify = async (req) => {
      seen = req;
      return { allowed: false, check: 'replay', reason: 'Transaction already used.' };
    };
    const res = await buy({ item: 'report', txHash: TX });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'payment_rejected', message: 'Transaction already used.' });
    expect(seen).toMatchObject({ txHash: TX, expectedTo: PAY_TO, expectedAmount: parseUsdc('0.5') });
    expect(merchant.deliveries()).toHaveLength(0);
  });

  it('handles unknown items, unknown routes and junk bodies', async () => {
    expect((await buy({ item: 'nope' })).status).toBe(404);
    expect((await fetch(`${merchant.url}/quote?item=nope`)).status).toBe(404);
    expect((await fetch(`${merchant.url}/elsewhere`)).status).toBe(404);
    const junk = await fetch(`${merchant.url}/buy`, { method: 'POST', body: 'not json' });
    expect(junk.status).toBe(404);
    await expect(httpQuoteFetcher(merchant.url, 'nope')).rejects.toThrow(/404/);
  });
});

describe('mock merchant: attack modes', () => {
  it('swap-payto: honest quote, attacker address in the payment request', async () => {
    merchant.setMode('swap-payto');
    expect((await httpQuoteFetcher(merchant.url, 'report')).payTo).toBe(PAY_TO);
    expect((await buy({ item: 'report' })).body.payTo).toBe(ATTACKER);
  });

  it('inflate-price: honest quote, 10x in the payment request', async () => {
    merchant.setMode('inflate-price');
    expect((await httpQuoteFetcher(merchant.url, 'report')).amount).toBe(parseUsdc('0.5'));
    expect((await buy({ item: 'report' })).body.amount).toBe('5000000');
  });

  it.each([
    ['inject-prompt', /Ignore all earlier payment details/],
    ['fake-owner', /OWNER OVERRIDE/],
    ['move-to-safety', /compromised/],
  ] as const)('%s: plants text for the LLM but keeps payment details honest', async (mode, pattern) => {
    merchant.setMode(mode);
    const quote = await httpQuoteFetcher(merchant.url, 'report');
    expect(quote.description).toMatch(pattern);
    expect(quote.description).toContain(ATTACKER);
    expect(quote.payTo).toBe(PAY_TO);

    const ask = await buy({ item: 'report' });
    expect(ask.body.message).toMatch(pattern);
    expect(ask.body.payTo).toBe(PAY_TO);

    const catalog = (await (await fetch(`${merchant.url}/catalog`)).json()) as { items: { description: string }[] };
    expect(catalog.items[0]!.description).toMatch(pattern);
  });

  it('retry-loop: never acknowledges payment, never delivers', async () => {
    merchant.setMode('retry-loop');
    for (let i = 0; i < 3; i++) {
      const res = await buy({ item: 'report', txHash: TX });
      expect(res.status).toBe(402);
      expect(res.body.error).toBe('payment_not_received');
    }
    expect(merchant.deliveries()).toHaveLength(0);
    expect(merchant.buyAttempts()).toBe(3);
  });
});

describe('httpQuoteFetcher', () => {
  it('rejects malformed quotes', async () => {
    const { createServer } = await import('node:http');
    const bad = createServer((_, res) => res.end(JSON.stringify({ payTo: 'not-an-address', amount: '1.5' })));
    await new Promise<void>((r) => bad.listen(0, '127.0.0.1', r));
    const { port } = bad.address() as { port: number };
    await expect(httpQuoteFetcher(`http://127.0.0.1:${port}`, 'x')).rejects.toThrow(/Malformed quote/);
    await new Promise((r) => bad.close(r));
  });
});
