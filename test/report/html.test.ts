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
      byCategory: { send: cat(guarded ? 1 : 0, 1), hold: cat(0, 0), receive: cat(0, 0), api: cat(0, 0), honest: cat(1, 1) },
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
  });

  it('lays the report out as tabs, leaving out the ones with nothing to show', () => {
    const tabsOf = (html: string) => [...html.matchAll(/role="tab" id="tab-([a-z]+)"/g)].map((m) => m[1]);
    const withHold = { ...saved(true), hold: { hotCap: parseUsdc('10'), hot: parseUsdc('10'), vault: parseUsdc('90'), swept: 0n } };

    expect(tabsOf(renderHtml(withHold, saved(false)))).toEqual(['overview', 'attacks', 'purchases', 'wallet', 'evidence', 'how']);
    // No hold data recorded: no Wallet tab.
    expect(tabsOf(renderHtml(saved(true)))).toEqual(['overview', 'attacks', 'purchases', 'evidence', 'how']);

    const html = renderHtml(withHold);
    for (const id of tabsOf(html)) {
      expect(html).toContain(`<div class="tab" id="${id}" role="tabpanel" aria-labelledby="tab-${id}"`);
    }
    // Panels are only hidden by the script, so the page still reads top to bottom without it.
    expect(html).not.toMatch(/<div class="tab"[^>]*hidden/);
    expect(html.match(/<script>/g)).toHaveLength(1);
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
    // The only script on the page is the page's own tab script.
    expect(html.match(/<script/g)).toHaveLength(1);
  });
});

describe('renderHtml accuracy', () => {
  it('shows the loss, not "did not run", when a scenario lost money and then errored', () => {
    const report = saved(false);
    report.report.results[0] = result({ passed: false, usdcLost: parseUsdc('0.5'), error: 'RPC went away' });
    const html = renderHtml(report);
    expect(html).toContain('<span class="outcome">Lost 0.5 USDC</span><span class="why">also failed: RPC went away</span>');
    expect(html).not.toContain('<span class="outcome">Did not run</span>');
  });

  it('escapes the error text shown beside a loss', () => {
    const report = saved(false);
    report.report.results[0] = result({ passed: false, usdcLost: parseUsdc('0.5'), error: '<script>alert(1)</script>' });
    const html = renderHtml(report);
    expect(html).toContain('also failed: &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('still says "did not run" for an error with no loss', () => {
    const report = saved(true);
    report.report.results[0] = result({ passed: false, error: 'No wallet' });
    expect(renderHtml(report)).toContain('<span class="outcome">Did not run</span><span class="why">No wallet</span>');
  });

  it('describes the price check as a comparison with the expected price', () => {
    const report = saved(true);
    report.report.results[0] = result({ decisions: [{ allowed: false, check: 'price', reason: 'Too expensive.' }] });
    const html = renderHtml(report);
    expect(html).toContain('the price was above the expected price');
    expect(html).not.toContain('above the quote');
  });

  it('does not credit a missing guard with stopping attacks', () => {
    const open = renderHtml(saved(false));
    expect(open).toContain('<dt>Attacks that cost nothing</dt><dd>0 of 1</dd>');
    expect(open).not.toContain('Attacks stopped');
    expect(renderHtml(saved(true))).toContain('<dt>Attacks stopped</dt><dd>1 of 1</dd>');
  });
});

describe('report --html with explicit paths', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'awg-html-'));
    const write = (name: string, s: SavedReport): string => {
      const path = join(dir, name);
      writeFileSync(path, serializeReport(s));
      return path;
    };
    const lines: string[] = [];
    const html = (...args: string[]) => reportCommand(['--html', '--out', dir, ...args], { log: (l) => lines.push(l), env: {} });
    const page = () => readFileSync(lines.join('\n').replace('Page: ', ''), 'utf8');
    return { dir, write, html, page };
  };

  it('puts the guarded run first even when the paths are given the other way round', async () => {
    const { dir, write, html, page } = setup();
    try {
      const guarded = write('g.json', saved(true));
      const open = write('n.json', saved(false));
      await html(open, guarded);
      expect(page()).toContain('With the guard, 1 of 1 attack failed and no money was lost. Without it, the same agent lost 0.5 USDC.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders one named run on its own, with no baseline', async () => {
    const { dir, write, html, page } = setup();
    try {
      await html(write('n.json', saved(false)));
      expect(page()).toContain('With no guard, the agent lost 0.5 USDC across 1 attack.');
      expect(page().match(/class="panel /g)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses two runs that are both guarded or both unguarded', async () => {
    const { dir, write, html } = setup();
    try {
      const a = write('a.json', saved(true));
      const b = write('b.json', saved(true, 'arc-testnet', '2026-11-17T05:00:00.000Z'));
      await expect(html(a, b)).rejects.toThrow(/one run with the guard and one without/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses runs from different networks, agents or scenario sets', async () => {
    const { dir, write, html } = setup();
    try {
      const guarded = write('g.json', saved(true));
      const offline = write('n.json', saved(false, 'fake'));
      await expect(html(guarded, offline)).rejects.toThrow(/same agent, network and scenarios/);

      const otherAgent = saved(false);
      const renamed: SavedReport = { ...otherAgent, report: { ...otherAgent.report, agentName: 'naive-scripted' } };
      await expect(html(guarded, write('o.json', renamed))).rejects.toThrow(/same agent, network and scenarios/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
