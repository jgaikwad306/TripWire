import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, FakeLedger } from '../../src/fakes/index.js';
import { compareCommand, noGuardCommand, withDefaultAll } from '../../src/redteam/commands.js';
import { refundToHot, type RefundSource } from '../../src/wallet/refund.js';

function world(balances: { attacker: string; merchant: string }) {
  const ledger = new FakeLedger({ hot: parseUsdc('1') });
  ledger.fund(FAKE_ADDRESSES.attacker, parseUsdc(balances.attacker));
  ledger.fund(FAKE_ADDRESSES.merchant, parseUsdc(balances.merchant));
  const source = (name: 'attacker' | 'merchant', keep: string): RefundSource => ({
    name,
    address: FAKE_ADDRESSES[name],
    keep: parseUsdc(keep),
    send: async (to, amount) => ledger.transferFrom(FAKE_ADDRESSES[name], to, amount),
  });
  return { ledger, source };
}

describe('refundToHot', () => {
  it('returns everything above each reserve to the hot wallet', async () => {
    const { ledger, source } = world({ attacker: '25', merchant: '3' });
    const results = await refundToHot({
      chain: ledger,
      hot: FAKE_ADDRESSES.hot,
      sources: [source('attacker', '1'), source('merchant', '0.1')],
    });

    expect(results.map((r) => r.amount)).toEqual([parseUsdc('24'), parseUsdc('2.9')]);
    expect(results.every((r) => r.txHash)).toBe(true);
    expect(await ledger.getBalance('hot')).toBe(parseUsdc('27.9'));
    expect(await ledger.getBalance('attacker')).toBe(parseUsdc('1'));
    expect(await ledger.getBalance('merchant')).toBe(parseUsdc('0.1'));
  });

  it('leaves a source alone when it holds no more than its reserve', async () => {
    const { ledger, source } = world({ attacker: '1', merchant: '0.05' });
    const results = await refundToHot({ chain: ledger, hot: FAKE_ADDRESSES.hot, sources: [source('attacker', '1'), source('merchant', '0.1')] });
    expect(results.map((r) => r.amount)).toEqual([0n, 0n]);
    expect(results.some((r) => r.txHash)).toBe(false);
    expect(await ledger.getBalance('hot')).toBe(parseUsdc('1'));
  });

  it('moves nothing on a dry run but reports what would move', async () => {
    const { ledger, source } = world({ attacker: '25', merchant: '3' });
    const results = await refundToHot({ chain: ledger, hot: FAKE_ADDRESSES.hot, dryRun: true, sources: [source('attacker', '1')] });
    expect(results[0]).toMatchObject({ balance: parseUsdc('25'), amount: parseUsdc('24') });
    expect(results[0]!.txHash).toBeUndefined();
    expect(await ledger.getBalance('attacker')).toBe(parseUsdc('25'));
  });

  it('keeps going when one source fails', async () => {
    const { ledger, source } = world({ attacker: '25', merchant: '3' });
    const broken: RefundSource = { ...source('attacker', '1'), send: async () => { throw new Error('rpc down'); } };
    const results = await refundToHot({ chain: ledger, hot: FAKE_ADDRESSES.hot, sources: [broken, source('merchant', '0.1')] });
    expect(results[0]).toMatchObject({ error: 'rpc down' });
    expect(results[1]!.txHash).toBeDefined();
    expect(await ledger.getBalance('hot')).toBe(parseUsdc('3.9'));
  });
});

describe('no-guard and compare shortcuts', () => {
  it('run every scenario unless the caller picks some', () => {
    expect(withDefaultAll('--no-guard', [])).toEqual(['--all', '--no-guard']);
    expect(withDefaultAll('--no-guard', ['--fake'])).toEqual(['--all', '--no-guard', '--fake']);
    expect(withDefaultAll('--compare', ['--scenario', 'replay'])).toEqual(['--compare', '--scenario', 'replay']);
    expect(withDefaultAll('--compare', ['--all'])).toEqual(['--compare', '--all']);
  });

  it('no-guard runs the unprotected baseline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awg-noguard-'));
    const lines: string[] = [];
    await noGuardCommand(['--fake', '--agent', 'naive', '--out', dir], { log: (l) => lines.push(l), env: {} });
    const out = lines.join('\n');
    expect(out).toContain('guard OFF');
    expect(out).toMatch(/Attacks stopped\s+1 \/ 24/);
    expect(readdirSync(dir).some((f) => f.endsWith('-no-guard.html'))).toBe(true);
  });

  it('compare runs both and writes the side-by-side page', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awg-compare-'));
    const lines: string[] = [];
    await compareCommand(['--fake', '--agent', 'naive', '--scenario', 'swap-payto', '--out', dir], { log: (l) => lines.push(l), env: {} });
    expect(lines.join('\n')).toContain('Guard on vs guard off');
    expect(readdirSync(dir).some((f) => f.endsWith('-comparison.html'))).toBe(true);
  });
});
