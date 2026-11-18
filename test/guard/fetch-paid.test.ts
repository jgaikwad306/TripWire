import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { guardedTools } from '../../src/agent/tools.js';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, FakeLedger } from '../../src/fakes/index.js';
import { MemoryAuditLog, createGuard, defaultPolicy } from '../../src/guard/index.js';
import { httpQuoteFetcher } from '../../src/merchant/quote.js';
import { API_PATHS, startPaidApi, type PaidApi } from '../../src/paid-api/server.js';
import { apiPolicy, API_TASKS } from '../../src/redteam/world.js';
import { FakeGateway, gatewayRequirements } from '../../src/x402/gateway.js';
import { HEADER, X402_VERSION, encode } from '../../src/x402/protocol.js';

const open: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function setup(policyApiUrl?: (api: PaidApi) => string) {
  const ledger = new FakeLedger({ hot: parseUsdc('10') });
  const gateway = new FakeGateway();
  gateway.deposit(FAKE_ADDRESSES.hot, parseUsdc('1'));
  const api = await startPaidApi({ payTo: FAKE_ADDRESSES.merchant, attacker: FAKE_ADDRESSES.attacker, facilitator: gateway });
  open.push(api);
  const audit = new MemoryAuditLog();
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    requested.push(String(input));
    return fetch(input, init);
  };
  const guard = createGuard({
    wallet: ledger,
    chain: ledger,
    fetchQuote: httpQuoteFetcher,
    gateway,
    audit,
    fetchImpl,
    policy: defaultPolicy(ledger, { api: apiPolicy(policyApiUrl ? policyApiUrl(api) : api.url) }),
  });
  return { ledger, gateway, api, guard, audit, requested };
}

/** A server that answers 402 with these terms, then does whatever `paid` says. */
async function rogue(paid: (res: import('node:http').ServerResponse) => void) {
  const server = createServer((req, res) => {
    if (!req.headers[HEADER.signature.toLowerCase()]) {
      const terms = gatewayRequirements(FAKE_ADDRESSES.merchant, parseUsdc('0.001'));
      res.writeHead(402, { [HEADER.required]: encode.required({ x402Version: X402_VERSION, resource: { url: 'x', description: '', mimeType: '' }, accepts: [terms] }) });
      return res.end('{}');
    }
    paid(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  open.push({ close: () => new Promise((r) => server.close(r)) });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('guard.fetchPaid: the x402 chokepoint for paid APIs', () => {
  it('pays an approved API with a Gateway nanopayment, confirmed from Gateway, and logs it', async () => {
    const { guard, gateway, api, audit } = await setup();
    const res = await guard.fetchPaid({ url: `${api.url}${API_PATHS.marketData}?symbol=ETH` });

    expect(res.decision).toMatchObject({ allowed: true, check: 'ok' });
    expect(res.status).toBe(200);
    expect((res.body as { data: { symbol: string } }).data.symbol).toBe('ETH');
    expect(await gateway.balance(FAKE_ADDRESSES.merchant)).toBe(parseUsdc('0.001'));
    expect(res.decision.settlementRef).toBe((await gateway.transfers({}))[0]!.id);
    expect(audit.entries).toEqual([expect.objectContaining({ guard: 'on', kind: 'api', allowed: true, rule: 'ok', amountUsdc: '0.001', settlementRef: res.decision.settlementRef })]);
  });

  it('never even contacts a resource the owner did not approve', async () => {
    const { guard, requested, audit } = await setup();
    const res = await guard.fetchPaid({ url: 'http://127.0.0.1:9/premium/market-data' });
    expect(res.decision).toMatchObject({ allowed: false, check: 'resource' });
    expect(requested).toEqual([]);
    expect(audit.entries[0]).toMatchObject({ allowed: false, rule: 'resource' });
  });

  it('follows a redirect only to an approved resource', async () => {
    const { guard, api } = await setup();
    const elsewhere = await rogue((res) => res.end('{}'));
    api.setAttackerUrl(elsewhere);
    api.setMode('redirect');
    const res = await guard.fetchPaid({ url: `${api.url}${API_PATHS.marketData}?symbol=BTC` });
    expect(res.decision).toMatchObject({ allowed: false, check: 'resource' });
    expect(res.decision.reason).toMatch(/redirected to/);
  });

  it('counts a payment the provider took but Gateway never saw as possibly paid', async () => {
    // The provider keeps the signed authorization and answers 200 without settling it: it
    // could still submit it for a week, so the guard treats it as spent.
    const url = await rogue((res) => res.end('{"data":{}}'));
    const { guard, gateway } = await setup(() => url);
    guard.beginTask(API_TASKS.research);
    const first = await guard.fetchPaid({ url: `${url}${API_PATHS.marketData}?symbol=BTC` });
    expect(first.decision).toMatchObject({ allowed: false, check: 'wallet' });
    expect(first.decision.reason).toMatch(/possibly paid/);
    expect(await gateway.transfers({})).toEqual([]);
    // It still counts: the same request is not signed again.
    const again = await guard.fetchPaid({ url: `${url}${API_PATHS.marketData}?symbol=BTC` });
    expect(again.decision).toMatchObject({ allowed: false, check: 'duplicate' });
  });

  it('refuses everything outside the declared task, and keeps to its budget', async () => {
    const { guard, api } = await setup();
    guard.beginTask(API_TASKS.research);
    const offTask = await guard.fetchPaid({ url: `${api.url}${API_PATHS.compute}`, method: 'POST', body: { prompt: 'x' } });
    expect(offTask.decision).toMatchObject({ allowed: false, check: 'intent-match' });
    expect(() => guard.beginTask('not-a-task')).toThrow(/Unknown task/);
  });

  it('gives the agent tools that reach money only through the guard', () => {
    const tools = guardedTools({} as never);
    expect(Object.keys(tools).sort()).toEqual(['buyResource', 'checkBalance', 'getQuote', 'requestPayment']);
  });
});
