import { describe, expect, it } from 'vitest';
import { ACTIVITY_LIMIT, ExplorerActivityReader, buildActivityReport } from '../../src/chain/activity.js';
import { USDC_ADDRESS, parseUsdc } from '../../src/constants.js';
import { FAKE_TOKEN_ADDRESS, FakeLedger } from '../../src/fakes/index.js';
import type { Address } from '../../src/types.js';

const WALLET: Address = '0x00000000000000000000000000000000000000b1';
const OTHER: Address = '0x00000000000000000000000000000000000000c1';
const THIRD: Address = '0x00000000000000000000000000000000000000c2';
const TX = `0x${'ab'.repeat(32)}`;

const item = (over: Record<string, unknown> = {}) => ({
  block_number: 10,
  timestamp: '2026-11-17T06:56:21.000000Z',
  transaction_hash: TX,
  from: { hash: '0x00000000000000000000000000000000000000B1' },
  to: { hash: OTHER },
  token: { address_hash: USDC_ADDRESS },
  total: { value: '1500000' },
  ...over,
});

function stubFetch(body: unknown, status = 200) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe('ExplorerActivityReader', () => {
  it('maps the explorer response to USDC transfers', async () => {
    const { fetchImpl, urls } = stubFetch({ items: [item()] });
    const reader = new ExplorerActivityReader({ baseUrl: 'https://explorer.example', fetchImpl });

    const transfers = await reader.getUsdcActivity(WALLET, 5);

    expect(transfers).toEqual([{ txHash: TX, from: WALLET, to: OTHER, amount: parseUsdc('1.5'), blockNumber: 10 }]);
    expect(urls[0]).toContain(`https://explorer.example/api/v2/addresses/${WALLET}/token-transfers`);
    expect(urls[0]).toContain(`token=${USDC_ADDRESS}`);
  });

  it('ignores transfers of other tokens and respects the limit', async () => {
    const items = [
      item({ token: { address_hash: FAKE_TOKEN_ADDRESS } }),
      item({ block_number: 9 }),
      item({ block_number: 8 }),
      item({ block_number: 7 }),
    ];
    const reader = new ExplorerActivityReader({ baseUrl: 'https://explorer.example', fetchImpl: stubFetch({ items }).fetchImpl });

    const transfers = await reader.getUsdcActivity(WALLET, 2);

    expect(transfers.map((t) => t.blockNumber)).toEqual([9, 8]);
  });

  it('fails clearly when the explorer answers with an error', async () => {
    const reader = new ExplorerActivityReader({ baseUrl: 'https://explorer.example', fetchImpl: stubFetch({}, 503).fetchImpl });
    await expect(reader.getUsdcActivity(WALLET, 5)).rejects.toThrow(/Explorer returned 503/);
  });

  it('fails clearly when the response has an unexpected shape', async () => {
    const read = (body: unknown) =>
      new ExplorerActivityReader({ baseUrl: 'https://explorer.example', fetchImpl: stubFetch(body).fetchImpl }).getUsdcActivity(WALLET, 5);
    await expect(read({ items: 'none' })).rejects.toThrow(/unexpected shape/);
    await expect(read({ items: [item({ total: { value: 'lots' } })] })).rejects.toThrow(/unexpected shape/);
  });

  it('drops a single unreadable entry instead of failing the whole report', async () => {
    const items = [item({ total: null }), item({ block_number: 9 }), item({ to: null })];
    const reader = new ExplorerActivityReader({ baseUrl: 'https://explorer.example', fetchImpl: stubFetch({ items }).fetchImpl });
    expect((await reader.getUsdcActivity(WALLET, 5)).map((t) => t.blockNumber)).toEqual([9]);
  });

  it('rejects an address that is not an address', async () => {
    const reader = new ExplorerActivityReader({ baseUrl: 'https://explorer.example', fetchImpl: stubFetch({ items: [] }).fetchImpl });
    await expect(reader.getUsdcActivity('0x123/../../x' as Address, 5)).rejects.toThrow(/not a valid address/);
  });
});

describe('FakeLedger activity', () => {
  it('lists an address\'s USDC transfers, newest first, and nothing else', async () => {
    const ledger = new FakeLedger();
    ledger.fund(WALLET, parseUsdc('10'));
    ledger.fund(OTHER, parseUsdc('10'));
    ledger.transferFrom(WALLET, OTHER, parseUsdc('1'));
    ledger.transferFrom(OTHER, THIRD, parseUsdc('2')); // not the wallet's
    ledger.counterfeitTransfer(OTHER, WALLET, parseUsdc('9')); // not USDC
    ledger.transferFrom(OTHER, WALLET, parseUsdc('3'));

    const all = await ledger.getUsdcActivity(WALLET, 10);
    expect(all.map((t) => t.amount)).toEqual([parseUsdc('3'), parseUsdc('1')]);
    expect(all[0]).toMatchObject({ from: OTHER, to: WALLET });
    expect((await ledger.getUsdcActivity(WALLET, 1)).map((t) => t.amount)).toEqual([parseUsdc('3')]);
  });
});

describe('buildActivityReport', () => {
  it('returns a compact report with amounts in USDC', async () => {
    const ledger = new FakeLedger();
    ledger.fund(WALLET, parseUsdc('10'));
    const txHash = ledger.transferFrom(WALLET, OTHER, parseUsdc('1.25'));

    const report = await buildActivityReport(ledger, WALLET);

    expect(report).toEqual({ address: WALLET, transfers: [{ tx: txHash, from: WALLET, to: OTHER, amount_usdc: '1.25', block: 1 }] });
  });

  it('caps the report so it fits in one tool result', async () => {
    const ledger = new FakeLedger();
    ledger.fund(WALLET, parseUsdc('100'));
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i++) ledger.transferFrom(WALLET, OTHER, parseUsdc('1'));

    const report = await buildActivityReport(ledger, WALLET);

    expect(report.transfers).toHaveLength(ACTIVITY_LIMIT);
    expect(JSON.stringify(report).length).toBeLessThan(4000);
  });
});
