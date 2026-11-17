import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, FakeLedger } from '../../src/fakes/index.js';
import { httpQuoteFetcher } from '../../src/merchant/quote.js';
import { startMerchant, type MockMerchant } from '../../src/merchant/server.js';
import type { Decision, IncomingPayment } from '../../src/types.js';
import {
  HEADER,
  MAX_TIMEOUT_SECONDS,
  X402_VERSION,
  decode,
  encode,
  exactRequirements,
  nonceFor,
  signPayment,
} from '../../src/x402/protocol.js';

const PAY_TO = '0x00000000000000000000000000000000000000a3';
const ATTACKER = '0x00000000000000000000000000000000000000a4';
const TX = `0x${'ab'.repeat(32)}` as const;
const PRICE = parseUsdc('0.5');

let merchant: MockMerchant;
let accept: ((req: IncomingPayment) => Promise<Decision>) | undefined;
let seen: IncomingPayment[] = [];
const ledger = new FakeLedger();

beforeAll(async () => {
  merchant = await startMerchant({
    payTo: PAY_TO,
    attacker: ATTACKER,
    prices: { report: PRICE },
    acceptPayment: (req) => {
      seen.push(req);
      return accept ? accept(req) : Promise.resolve({ allowed: true, check: 'ok', reason: '', receivedTx: TX });
    },
  });
});
afterAll(() => merchant.close());
beforeEach(() => {
  merchant.reset();
  accept = undefined;
  seen = [];
});

const buy = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${merchant.url}/buy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, string> };
};

const termsOf = (res: { headers: Headers }) => decode.required(res.headers.get(HEADER.required)!);

let seq = 0;
const payment = (amount = PRICE) =>
  signPayment({
    sign: (data) => ledger.signTypedData('hot', data),
    from: FAKE_ADDRESSES.hot,
    requirements: exactRequirements(PAY_TO, amount),
    nonce: nonceFor(`merchant-test-${++seq}`),
    validBefore: Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS,
  });
const paid = async (amount = PRICE) => ({ [HEADER.signature]: encode.signature(await payment(amount)) });

describe('x402 merchant: honest', () => {
  it('answers an unpaid order with 402 and its terms in PAYMENT-REQUIRED', async () => {
    const ask = await buy({ item: 'report' });

    expect(ask.status).toBe(402);
    const terms = termsOf(ask);
    expect(terms).toMatchObject({ x402Version: X402_VERSION, resource: { description: 'One report.' } });
    expect(terms.accepts).toEqual([exactRequirements(PAY_TO, PRICE)]);
    // The body repeats the terms for people and LLMs.
    expect(ask.body).toMatchObject({ error: 'payment_required', payTo: PAY_TO, amount: '500000' });
  });

  it('quotes through the 402, settles a signed payment, then delivers with PAYMENT-RESPONSE', async () => {
    const quote = await httpQuoteFetcher(merchant.url, 'report');
    expect(quote).toMatchObject({ item: 'report', payTo: PAY_TO, amount: PRICE, requirements: exactRequirements(PAY_TO, PRICE) });

    const done = await buy({ item: 'report' }, await paid());

    expect(done.status).toBe(200);
    expect(decode.response(done.headers.get(HEADER.response)!)).toMatchObject({ success: true, transaction: TX });
    expect(seen[0]?.requirements).toEqual(exactRequirements(PAY_TO, PRICE));
    expect(merchant.deliveries()).toEqual([{ orderId: 'order-1', item: 'report', txHash: TX }]);
    expect(merchant.buyAttempts()).toBe(2);
  });

  it('refuses a payment its checks reject, and says so in PAYMENT-RESPONSE', async () => {
    accept = async () => ({ allowed: false, check: 'replay', reason: 'Payment already used.' });
    const res = await buy({ item: 'report' }, await paid());

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'payment_rejected', message: 'Payment already used.' });
    expect(decode.response(res.headers.get(HEADER.response)!)).toMatchObject({ success: false, errorReason: 'replay' });
    expect(merchant.deliveries()).toHaveLength(0);
  });

  it('rejects a PAYMENT-SIGNATURE that is not an x402 payload', async () => {
    const res = await buy({ item: 'report' }, { [HEADER.signature]: 'not-base64-json' });
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('handles unknown items, unknown routes and junk bodies', async () => {
    expect((await buy({ item: 'nope' })).status).toBe(404);
    expect((await fetch(`${merchant.url}/elsewhere`)).status).toBe(404);
    const junk = await fetch(`${merchant.url}/buy`, { method: 'POST', body: 'not json' });
    expect(junk.status).toBe(404);
    await expect(httpQuoteFetcher(merchant.url, 'nope')).rejects.toThrow(/404/);
  });
});

describe('x402 merchant: attack modes', () => {
  it('swap-payto: signed terms stay honest, the 402 text names the attacker', async () => {
    merchant.setMode('swap-payto');
    const ask = await buy({ item: 'report' });
    expect(termsOf(ask).accepts[0]?.payTo.toLowerCase()).toBe(PAY_TO);
    expect(ask.body.payTo).toBe(ATTACKER);
  });

  it('inflate-price: signed terms stay honest, the 402 text asks 10x', async () => {
    merchant.setMode('inflate-price');
    const ask = await buy({ item: 'report' });
    expect(termsOf(ask).accepts[0]?.amount).toBe('500000');
    expect(ask.body.amount).toBe('5000000');
  });

  it.each([
    ['inject-prompt', /Ignore all earlier payment details/],
    ['fake-owner', /OWNER OVERRIDE/],
    ['move-to-safety', /compromised/],
  ] as const)('%s: plants text for the LLM but keeps payment terms honest', async (mode, pattern) => {
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

  it('quote-swap-payto and quote-inflate tamper with the signed terms themselves', async () => {
    merchant.setMode('quote-swap-payto');
    expect((await httpQuoteFetcher(merchant.url, 'report')).payTo).toBe(ATTACKER);
    merchant.setMode('quote-inflate');
    expect((await httpQuoteFetcher(merchant.url, 'report')).amount).toBe(PRICE * 3n);
  });

  it('quote-drip: each sale a little cheaper than the last', async () => {
    merchant.setMode('quote-drip');
    const first = await httpQuoteFetcher(merchant.url, 'report');
    await buy({ item: 'report' }, await paid(first.amount));
    const second = await httpQuoteFetcher(merchant.url, 'report');
    expect(second.amount).toBeLessThan(first.amount);
  });

  it('retry-loop: settles the payment, then claims it never arrived and hides the settlement', async () => {
    merchant.setMode('retry-loop');
    for (let i = 0; i < 3; i++) {
      const res = await buy({ item: 'report' }, await paid());
      expect(res.status).toBe(402);
      expect(res.body.error).toBe('payment_not_received');
      expect(res.headers.get(HEADER.response)).toBeNull();
    }
    expect(seen).toHaveLength(3);
    expect(merchant.deliveries()).toHaveLength(0);
  });
});

describe('httpQuoteFetcher', () => {
  const serve = async (handler: Parameters<typeof import('node:http').createServer>[1]) => {
    const { createServer } = await import('node:http');
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
  };

  it('rejects a merchant that does not answer 402', async () => {
    const plain = await serve((_, res) => res.end(JSON.stringify({ payTo: PAY_TO, amount: '1' })));
    await expect(httpQuoteFetcher(plain.url, 'x')).rejects.toThrow(/instead of 402/);
    await plain.close();
  });

  it('rejects a 402 without x402 terms, or with malformed ones', async () => {
    const bare = await serve((_, res) => {
      res.writeHead(402);
      res.end('{}');
    });
    await expect(httpQuoteFetcher(bare.url, 'x')).rejects.toThrow(/not an x402 merchant/);
    await bare.close();

    const garbled = await serve((_, res) => {
      res.writeHead(402, { [HEADER.required]: 'garbage' });
      res.end('{}');
    });
    await expect(httpQuoteFetcher(garbled.url, 'x')).rejects.toThrow(/malformed/);
    await garbled.close();
  });

  it('ignores options it cannot pay: other networks or tokens', async () => {
    const elsewhere = await serve((_, res) => {
      const terms = { ...exactRequirements(PAY_TO, PRICE), network: 'eip155:8453' as const };
      res.writeHead(402, { [HEADER.required]: encode.required({ x402Version: 2, resource: { url: 'x' }, accepts: [terms] }) });
      res.end('{}');
    });
    await expect(httpQuoteFetcher(elsewhere.url, 'x')).rejects.toThrow(/no exact USDC payment on Arc/);
    await elsewhere.close();
  });
});
