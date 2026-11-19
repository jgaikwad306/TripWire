import { describe, expect, it } from 'vitest';
import { GeminiClient, GeminiError, RestVenue, GeminiMarketData } from '../../src/gemini/client.js';
import { NonceSource, signRequest } from '../../src/gemini/signing.js';
import { costOf, units } from '../../src/gemini/money.js';
import { loadSnapshot, pickDemoMarket } from '../../src/gemini/snapshot.js';

describe('Gemini request signing', () => {
  it('matches an HMAC-SHA384 vector computed with openssl, with an empty body', () => {
    const headers = signRequest('/v1/prediction-markets/order', { symbol: 'GEMI-X', side: 'buy' }, { apiKey: 'k', apiSecret: 'test-secret' }, 1700000000);
    // printf '%s' "$PAYLOAD" | openssl dgst -sha384 -hmac test-secret
    expect(headers['X-GEMINI-PAYLOAD']).toBe('eyJyZXF1ZXN0IjoiL3YxL3ByZWRpY3Rpb24tbWFya2V0cy9vcmRlciIsIm5vbmNlIjoxNzAwMDAwMDAwLCJzeW1ib2wiOiJHRU1JLVgiLCJzaWRlIjoiYnV5In0=');
    expect(headers['X-GEMINI-SIGNATURE']).toBe('3b76a8f25c9869bcc49b1a5c92cef057fdd87afa4e18d76a1d8f2fcb196263edc3f64d445469c53774d0789550e58638');
    expect(headers['Content-Length']).toBe('0');
    expect(headers['X-GEMINI-APIKEY']).toBe('k');
  });

  it('adds the account only for master keys, and keeps incremental nonces strictly increasing', () => {
    const payload = (h: Record<string, string>) => JSON.parse(Buffer.from(h['X-GEMINI-PAYLOAD']!, 'base64').toString());
    expect(payload(signRequest('/p', {}, { apiKey: 'k', apiSecret: 's', account: 'primary' }, 1))).toMatchObject({ account: 'primary' });
    expect(payload(signRequest('/p', {}, { apiKey: 'k', apiSecret: 's' }, 1))).not.toHaveProperty('account');
    const frozen = new NonceSource('increment', () => 1000);
    expect([frozen.next(), frozen.next(), frozen.next()]).toEqual([1000, 1001, 1002]);
    const seconds = new NonceSource('time', () => 1_700_000_000_999);
    // Epoch seconds, and never repeated: Gemini refuses a nonce that has not increased.
    expect([seconds.next(), seconds.next()]).toEqual([1_700_000_000, 1_700_000_001]);
  });
});

describe('GeminiClient', () => {
  const snapshot = loadSnapshot();

  it('reads events and books from real captured shapes', async () => {
    const event = snapshot.events[0]!;
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      const body = String(url).includes('/v1/book/') ? snapshot.books[Object.keys(snapshot.books)[0]!] : String(url).includes('/events/') ? rawEvent(event) : { data: [rawEvent(event)], pagination: { limit: 1, offset: 0, total: 1 } };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const client = new GeminiClient({ fetchImpl });
    expect((await client.listEvents({ limit: 1 }))[0]!.ticker).toBe(event.ticker);
    expect((await client.getEvent(event.ticker)).contracts.length).toBe(event.contracts.length);
    expect((await client.getBook('GEMI-X')).asks.length).toBeGreaterThan(0);
    expect(calls[0]).toContain('/v1/prediction-markets/events?status=active&limit=1');
  });

  it('sends signed, empty-body POSTs and places immediate-or-cancel limit orders', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init;
      // Raw text, as Gemini sends it: an int64 above 2^53.
      return new Response('{"orderId":9007199254740993,"status":"filled","filledQuantity":"1","remainingQuantity":"0","avgExecutionPrice":"0.5"}', { status: 201 });
    }) as typeof fetch;
    const client = new GeminiClient({ fetchImpl, credentials: { apiKey: 'k', apiSecret: 's' } });
    const order = await client.placeOrder({ symbol: 'GEMI-X', side: 'buy', outcome: 'yes', quantity: '1', price: '0.5' });
    expect(order.orderId).toBe('9007199254740993'); // exact, not rounded by JSON.parse
    expect(seen?.body).toBeUndefined();
    const payload = JSON.parse(Buffer.from(new Headers(seen!.headers).get('x-gemini-payload')!, 'base64').toString());
    expect(payload).toMatchObject({ request: '/v1/prediction-markets/order', orderType: 'limit', timeInForce: 'immediate-or-cancel', outcome: 'yes' });
  });

  it('turns failures into GeminiError without leaking the secret or signature', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ result: 'error', reason: 'InvalidSignature', message: 'bad sig' }), { status: 400 })) as typeof fetch;
    const client = new GeminiClient({ fetchImpl, credentials: { apiKey: 'key-123', apiSecret: 'super-secret' } });
    const err = await client.positions().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GeminiError);
    expect((err as GeminiError).reason).toBe('InvalidSignature');
    expect(String((err as Error).message)).not.toMatch(/super-secret|key-123/);
    await expect(new GeminiClient().positions()).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it('RestVenue reads data from its own source and maps orders', async () => {
    const data = new GeminiMarketData(new GeminiClient({ fetchImpl: (async () => new Response(JSON.stringify(rawEvent(snapshot.events[0]!)))) as typeof fetch }));
    const trading = new GeminiClient({ credentials: { apiKey: 'k', apiSecret: 's' }, fetchImpl: (async () => new Response(JSON.stringify({ orderId: 7, status: 'cancelled', filledQuantity: '0', remainingQuantity: '0' }), { status: 201 })) as typeof fetch });
    const venue = new RestVenue('sandbox', trading, data);
    expect((await venue.getEvent('x')).ticker).toBe(snapshot.events[0]!.ticker);
    expect(await venue.placeOrder({ symbol: 's', side: 'buy', outcome: 'yes', quantity: '1', price: '0.4' })).toEqual({ orderId: '7', status: 'cancelled', filledQuantity: '0', remainingQuantity: '0' });
  });
});

describe('snapshot and money', () => {
  it('picks a demo market from real data and prices orders in their outcome space', () => {
    const snap = loadSnapshot();
    const demo = pickDemoMarket(snap.events, Date.parse(snap.capturedAt));
    expect(Number(demo.task.bestAsk)).toBeGreaterThanOrEqual(0.1);
    expect(Number(demo.task.bestAsk)).toBeLessThanOrEqual(0.9);
    expect(new Set([demo.task.eventTicker, demo.offTask.eventTicker, demo.thin.eventTicker]).size).toBe(3);
    expect(demo.strikes.length).toBeGreaterThanOrEqual(4);
    expect(costOf({ quantity: '5', price: '0.42' })).toBe(units('2.1'));
  });
});

/** Back to Gemini's wire shape (prices under `prices`), as the API serves it. */
function rawEvent(e: ReturnType<typeof loadSnapshot>['events'][number]) {
  return {
    ...e,
    expiryDate: e.expiresAt,
    contracts: e.contracts.map((c) => ({ ...c, expiryDate: c.expiresAt, prices: { bestBid: c.bestBid, bestAsk: c.bestAsk, lastTradePrice: c.lastTradePrice } })),
  };
}
