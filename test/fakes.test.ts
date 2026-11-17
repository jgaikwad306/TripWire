import { describe, expect, it } from 'vitest';
import { USDC_ADDRESS, formatUsdc, parseUsdc } from '../src/constants.js';
import { FAKE_ADDRESSES, createFakeContext } from '../src/fakes/index.js';

describe('usdc helpers', () => {
  it('round-trips amounts', () => {
    expect(parseUsdc('1.5')).toBe(1_500_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc('20')).toBe(20_000_000n);
    expect(formatUsdc(1_500_000n)).toBe('1.5');
    expect(formatUsdc(20_000_000n)).toBe('20');
    expect(() => parseUsdc('1.2345678')).toThrow();
    expect(() => parseUsdc('abc')).toThrow();
  });
});

describe('fake world (no guard)', () => {
  it('completes an honest purchase and records it onchain', async () => {
    const ctx = createFakeContext();
    const result = await ctx.agent.run(`buy report from ${ctx.merchant.url}`, ctx.tools);

    expect(await ctx.wallet.getBalance('merchant')).toBe(parseUsdc('0.5'));
    expect(await ctx.wallet.getBalance('hot')).toBe(parseUsdc('9.5'));

    const decision = ctx.guard.decisions()[0]!;
    expect(decision.allowed).toBe(true);
    const tx = await ctx.chain.getTx(decision.txHash!);
    expect(tx?.status).toBe('success');
    expect(tx?.transfers[0]).toMatchObject({ token: USDC_ADDRESS, to: FAKE_ADDRESSES.merchant, value: parseUsdc('0.5') });
    expect(result.toolCalls.map((c) => c.name)).toEqual(['get_quote', 'request_payment']);
  });

  it('loses funds to a swapped payTo — the baseline the real guard must beat', async () => {
    const ctx = createFakeContext();
    ctx.merchant.setMode('swap-payto');
    await ctx.agent.run(`buy report from ${ctx.merchant.url}`, ctx.tools);

    expect(await ctx.chain.getUsdcBalance(ctx.attacker)).toBe(parseUsdc('0.5'));
    expect(await ctx.wallet.getBalance('merchant')).toBe(0n);
  });

  it('overpays on an inflated price', async () => {
    const ctx = createFakeContext();
    ctx.merchant.setMode('inflate-price');
    await ctx.agent.run(`buy report from ${ctx.merchant.url}`, ctx.tools);
    expect(await ctx.wallet.getBalance('merchant')).toBe(parseUsdc('5'));
  });
});

describe('fake ledger receive-side helpers', () => {
  it('distinguishes real USDC, counterfeit tokens and missing transactions', async () => {
    const { ledger } = createFakeContext();
    const customer = '0x00000000000000000000000000000000000000c1' as const;
    ledger.fund(customer, parseUsdc('3'));

    const real = await ledger.getTx(ledger.transferFrom(customer, FAKE_ADDRESSES.merchant, parseUsdc('2')));
    expect(real?.transfers[0]?.token).toBe(USDC_ADDRESS);

    const fake = await ledger.getTx(ledger.counterfeitTransfer(customer, FAKE_ADDRESSES.merchant, parseUsdc('2')));
    expect(fake?.transfers[0]?.token).not.toBe(USDC_ADDRESS);
    expect(await ledger.getBalance('merchant')).toBe(parseUsdc('2'));

    expect(await ledger.getTx(ledger.nonexistentTxHash())).toBeNull();
    expect(() => ledger.transferFrom(customer, FAKE_ADDRESSES.merchant, parseUsdc('5'))).toThrow(/Insufficient/);
  });
});
