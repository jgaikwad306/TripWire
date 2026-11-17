import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { latestPair, reportCommand } from '../../src/redteam/commands.js';
import { renderHtml } from '../../src/report/html.js';
import { serializeReport, type Network, type SavedReport } from '../../src/report/store.js';
import type { ScenarioResult } from '../../src/types.js';

const TX = `0x${'ab'.repeat(32)}` as const;

const result = (over: Partial<ScenarioResult>): ScenarioResult => ({
  id: 'swap-payto',
  title: '#1 Swapped payTo',
  category: 'send',
  expected: 'blocked',
  passed: true,
  usdcLost: 0n,
  txHashes: [],
  decisions: [],
  ...over,
});

function saved(guarded: boolean, network: Network = 'arc-testnet', startedAt = '2026-11-17T03:39:39.168Z'): SavedReport {
  const attack = guarded
    ? result({ decisions: [{ allowed: false, check: 'intent-match', reason: 'payTo differs from the quote.' }] })
    : result({ passed: false, usdcLost: parseUsdc('0.5'), txHashes: [TX], decisions: [{ allowed: true, check: 'none', reason: 'No guard.', txHash: TX }] });
  const honest = result({ id: 'honest-1', title: 'H1 Normal purchase', category: 'honest', expected: 'completed', txHashes: [TX] });
  const cat = (passed: number, total: number) => ({ passed, total, score: total ? Math.round((passed / total) * 100) : 0 });
  return {
    network,
    report: {
      agentName: 'grok:test',
      guarded,
      startedAt,
      overall: guarded ? 100 : 20,
      byCategory: { send: cat(guarded ? 1 : 0, 1), hold: cat(0, 0), receive: cat(0, 0), honest: cat(1, 1) },
      usdcLost: guarded ? 0n : parseUsdc('0.5'),
      honestCompleted: 1,
      honestTotal: 1,
      results: [attack, honest],
    },
  };
}

describe('renderHtml', () => {
  it('shows the guarded run beside the baseline in plain words', () => {
    const html = renderHtml(saved(true), saved(false));
    expect(html).toContain('With the guard, 1 of 1 attack failed and no money was lost. Without it, the same agent lost 0.5 USDC.');
    expect(html).toContain('the payment did not match the quote');
    expect(html).toContain('Lost 0.5 USDC');
    expect(html).toContain('Swapped payTo');
    expect(html).not.toContain('#1 Swapped payTo');
    expect(html.match(/class="panel /g)).toHaveLength(2);
    expect(html).not.toContain('<script');
  });

  it('links transactions to the explorer only for runs on Arc Testnet', () => {
    expect(renderHtml(saved(false))).toContain(`href="https://testnet.arcscan.app/tx/${TX}"`);
    const offline = renderHtml(saved(false, 'fake'));
    expect(offline).not.toContain('arcscan');
    expect(offline).toContain('simulated');
  });

  it('renders a single run on its own', () => {
    const html = renderHtml(saved(false));
    expect(html).toContain('With no guard, the agent lost 0.5 USDC across 1 attack.');
    expect(html.match(/class="panel /g)).toHaveLength(1);
  });

  it('escapes text an attacker could plant in notes, reasons, errors and names', () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const report = saved(true);
    report.report.agentName = evil;
    report.report.results[0] = result({
      title: `#1 ${evil}`,
      notes: evil,
      error: evil,
      decisions: [{ allowed: false, check: evil, reason: evil }],
    });
    const html = renderHtml(report, saved(false));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
  });
});

describe('report --html', () => {
  it('pairs the newest unguarded run with a guarded run over the same scenarios', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awg-html-'));
    try {
      const write = (name: string, s: SavedReport) => writeFileSync(join(dir, name), serializeReport(s));
      write('2026-11-17T03-00-00-000Z-guarded.json', saved(true, 'arc-testnet', '2026-11-17T03:00:00.000Z'));
      write('2026-11-17T03-05-00-000Z-no-guard.json', saved(false, 'arc-testnet', '2026-11-17T03:05:00.000Z'));
      // Newer, but offline: must not be paired with the Arc baseline.
      write('2026-11-17T04-00-00-000Z-guarded.json', saved(true, 'fake', '2026-11-17T04:00:00.000Z'));
      writeFileSync(join(dir, 'junk.json'), '{not a report');

      const pair = latestPair(dir);
      expect(pair?.guarded.report.startedAt).toBe('2026-11-17T03:00:00.000Z');
      expect(pair?.baseline.report.guarded).toBe(false);

      const lines: string[] = [];
      await reportCommand(['--html', '--out', dir], { log: (l) => lines.push(l), env: {} });
      const path = lines.join('\n').replace('Page: ', '');
      expect(path).toMatch(/2026-11-17T03-00-00-000Z-comparison\.html$/);
      expect(readFileSync(path, 'utf8')).toContain('Without it, the same agent lost 0.5 USDC.');
      expect(latestPair(join(dir, 'missing'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
