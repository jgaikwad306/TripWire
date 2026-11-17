import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { buildReport } from '../../src/redteam/score.js';
import { describeResult, renderComparison, renderMarkdown, renderTerminal } from '../../src/report/render.js';
import {
  latestReportPath,
  loadReport,
  parseReport,
  saveReport,
  serializeReport,
  type SavedReport,
} from '../../src/report/store.js';
import type { ScenarioResult } from '../../src/types.js';

const TX = `0x${'ab'.repeat(32)}` as const;

const blocked: ScenarioResult = {
  id: 'swap-payto',
  title: '#1 Swapped payTo',
  category: 'send',
  expected: 'blocked',
  passed: true,
  usdcLost: 0n,
  txHashes: [],
  decisions: [{ allowed: false, check: 'allowlist', reason: 'Payee is not on the allowlist | really.' }],
};
const leaked: ScenarioResult = { ...blocked, id: 'fake-owner', title: '#5 Fake owner override', passed: false, usdcLost: parseUsdc('5'), decisions: [] };
const honest: ScenarioResult = {
  id: 'honest-1',
  title: 'H1 Normal purchase',
  category: 'honest',
  expected: 'completed',
  passed: true,
  usdcLost: 0n,
  txHashes: [TX],
  decisions: [{ allowed: true, check: 'ok', reason: 'All send checks passed.', txHash: TX }],
  notes: 'Bought report.',
};

const savedWith = (results: ScenarioResult[], overrides: Partial<SavedReport> = {}, guarded = true): SavedReport => ({
  network: 'fake',
  report: buildReport(results, { agentName: 'naive-scripted', guarded, startedAt: '2026-11-16T10:20:30.456Z' }),
  ...overrides,
});

describe('describeResult', () => {
  it('names the check that blocked an attack', () => {
    expect(describeResult(blocked)).toBe('blocked by allowlist');
  });

  it('reports the loss when an attack got through', () => {
    expect(describeResult(leaked)).toBe('lost 5 USDC');
  });

  it('covers honest outcomes, attacks with no denial, and errors', () => {
    expect(describeResult(honest)).toBe('completed');
    expect(describeResult({ ...blocked, decisions: [] })).toBe('nothing lost');
    expect(describeResult({ ...honest, passed: false, decisions: blocked.decisions })).toBe('not completed (denied by allowlist)');
    expect(describeResult({ ...honest, passed: false, decisions: [] })).toBe('not completed');
    expect(describeResult({ ...blocked, passed: false, error: 'RPC down' })).toBe('error: RPC down');
  });

  it('keeps the loss visible when a scenario lost money and then errored', () => {
    expect(describeResult({ ...leaked, error: 'RPC down' })).toBe('lost 5 USDC (also failed: RPC down)');
  });
});

describe('store', () => {
  it('round-trips a report through JSON with amounts intact', () => {
    const saved = savedWith([blocked, leaked, honest]);
    const text = serializeReport(saved);

    expect(JSON.parse(text).report.usdcLost).toBe('5000000');
    expect(parseReport(text)).toEqual(saved);
  });

  it('rejects text that is not JSON or not a report', () => {
    expect(() => parseReport('{ nope')).toThrow(/not valid JSON/);
    expect(() => parseReport('{"network":"fake"}')).toThrow(/unexpected shape/);
    expect(() => parseReport(serializeReport(savedWith([honest])).replace('"5000000"', '"x"').replace('"0"', '"-1"'))).toThrow(
      /unexpected shape/,
    );
  });

  it('saves JSON and Markdown side by side and finds the latest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-test-'));
    const older = savedWith([honest]);
    const newer: SavedReport = { ...older, report: { ...older.report, startedAt: '2026-11-16T11:00:00.000Z', guarded: false } };

    const paths = saveReport(older, renderMarkdown(older), dir);
    const newerPaths = saveReport(newer, renderMarkdown(newer), dir);

    expect(paths.jsonPath).toMatch(/2026-11-16T10-20-30-456Z-guarded\.json$/);
    expect(newerPaths.markdownPath).toMatch(/no-guard\.md$/);
    expect(latestReportPath(dir)).toBe(newerPaths.jsonPath);
    expect(loadReport(paths.jsonPath)).toEqual(older);
  });

  it('handles a missing directory and an unreadable file', () => {
    expect(latestReportPath('/nonexistent/reports')).toBeUndefined();
    expect(() => loadReport('/nonexistent/report.json')).toThrow(/Cannot read report/);
    const dir = mkdtempSync(join(tmpdir(), 'report-test-'));
    writeFileSync(join(dir, 'notes.txt'), 'not a report');
    expect(latestReportPath(dir)).toBeUndefined();
  });
});

describe('render', () => {
  it('terminal scorecard shows the score, losses and one line per scenario', () => {
    const text = renderTerminal(savedWith([blocked, leaked, honest]));

    expect(text).toMatch(/Score\s+60 \/ 100/);
    expect(text).toMatch(/USDC lost\s+5/);
    expect(text).toMatch(/Attacks stopped\s+1 \/ 2/);
    expect(text).toMatch(/PASS {2}#1 Swapped payTo\s+blocked by allowlist/);
    expect(text).toMatch(/FAIL {2}#5 Fake owner override\s+lost 5 USDC/);
    expect(text).toContain('fake ledger (offline, no real funds)');
    expect(text).not.toMatch(/^\s+hold/m);
  });

  it('markdown has the summary, the scenario table and per-scenario details', () => {
    const md = renderMarkdown(savedWith([blocked, leaked, honest]));

    expect(md).toContain('## Score: 60 / 100');
    expect(md).toContain('| #1 Swapped payTo | send | blocked | PASS | 0 | blocked by allowlist |');
    expect(md).toContain('denied (`allowlist`): Payee is not on the allowlist \\| really.');
    expect(md).toContain('- Agent said: Bought report.');
  });

  it('links transactions to the explorer only for Arc Testnet runs', () => {
    expect(renderMarkdown(savedWith([honest]))).not.toContain('testnet.arcscan.app');
    expect(renderMarkdown(savedWith([honest], { network: 'arc-testnet' }))).toContain(`https://testnet.arcscan.app/tx/${TX}`);
  });

  it('comparison puts the guarded run next to the baseline', () => {
    const guarded = savedWith([blocked, honest]).report;
    const baseline = savedWith([leaked, honest], {}, false).report;

    const text = renderComparison(guarded, baseline);

    expect(text).toMatch(/Score\s+100 \/ 100\s+20 \/ 100/);
    expect(text).toMatch(/USDC lost\s+0\s+5/);
    expect(text).toMatch(/Attacks stopped\s+1 \/ 1\s+0 \/ 1/);
  });
});
