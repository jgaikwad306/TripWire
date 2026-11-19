import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUsdc } from '../constants.js';
import type { ScenarioResult } from '../types.js';
import type { SavedReport } from './store.js';

/** Where `npm run redteam` writes its comparison for people and tools to read. */
export const DEFAULT_RESULTS_DIR = 'results';

export interface ResultRow {
  attack: string;
  id: string;
  category: string;
  guardMode: 'on' | 'off';
  /** paid: money was lost; blocked: a rule refused; no-loss: nothing moved for another reason; completed/failed: honest purchases. */
  outcome: 'paid' | 'blocked' | 'no-loss' | 'completed' | 'failed' | 'unknown';
  usdcLost: string;
  /** The rule that stopped it (guard on), or the reason nothing was lost. */
  rule: string | null;
  /** Gateway transfer ids and onchain transactions for what was paid. */
  paymentRefs: string[];
}

function row(r: ScenarioResult, guardMode: 'on' | 'off'): ResultRow {
  const denied = r.decisions.find((d) => !d.allowed);
  const outcome: ResultRow['outcome'] =
    r.measurementStatus === 'unknown'
      ? 'unknown'
      : r.expected === 'completed'
        ? r.passed ? 'completed' : 'failed'
        : r.usdcLost > 0n
          ? 'paid'
          : denied && guardMode === 'on'
            ? 'blocked'
            : 'no-loss';
  const refs = [
    ...r.decisions.flatMap((d) => (d.settlementRef ? [`gateway:${d.settlementRef}`] : [])),
    ...r.decisions.flatMap((d) => (d.orderRef ? [`gemini-order:${d.orderRef}`] : [])),
    ...r.txHashes,
  ];
  return {
    attack: r.title,
    id: r.id,
    category: r.category,
    guardMode,
    outcome,
    usdcLost: formatUsdc(r.usdcLost),
    rule: guardMode === 'on' ? (r.stoppedBy ?? denied?.check ?? null) : (denied?.reason ?? null),
    paymentRefs: [...new Set(refs)],
  };
}

export interface RedTeamResults {
  network: SavedReport['network'];
  agent: string;
  startedAt: string;
  summary: {
    attacks: number;
    blockedWithGuard: number;
    lostWithGuardOff: string;
    lostWithGuardOn: string;
    /** Prediction market runs only: USD at risk on Gemini. Kept apart from USDC. */
    atRiskWithGuardOff?: string;
    atRiskWithGuardOn?: string;
    honestCompletedWithGuard: string;
  };
  rows: ResultRow[];
}

export function buildResults(guarded: SavedReport, baseline: SavedReport): RedTeamResults {
  const attacks = guarded.report.results.filter((r) => r.expected === 'blocked');
  const rows = baseline.report.results.flatMap((off) => {
    const on = guarded.report.results.find((r) => r.id === off.id);
    return [row(off, 'off'), ...(on ? [row(on, 'on')] : [])];
  });
  return {
    network: guarded.network,
    agent: guarded.report.agentName,
    startedAt: guarded.report.startedAt,
    summary: {
      attacks: attacks.length,
      blockedWithGuard: attacks.filter((r) => r.passed).length,
      lostWithGuardOff: formatUsdc(baseline.report.usdcLost),
      lostWithGuardOn: formatUsdc(guarded.report.usdcLost),
      ...(baseline.report.usdAtRisk !== undefined || guarded.report.usdAtRisk !== undefined
        ? { atRiskWithGuardOff: formatUsdc(baseline.report.usdAtRisk ?? 0n), atRiskWithGuardOn: formatUsdc(guarded.report.usdAtRisk ?? 0n) }
        : {}),
      honestCompletedWithGuard: `${guarded.report.honestCompleted} / ${guarded.report.honestTotal}`,
    },
    rows,
  };
}

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderResultsMarkdown(results: RedTeamResults): string {
  const { summary } = results;
  const lines = [
    '# Red-team results: guard off vs guard on',
    '',
    `Network: ${results.network === 'fake' ? 'offline fake ledger (no real funds)' : 'Arc Testnet'} · Agent: ${results.agent} · Started: ${results.startedAt}`,
    '',
    `- Attacks blocked with the guard on: **${summary.blockedWithGuard} / ${summary.attacks}**`,
    `- USDC lost with the guard off: **${summary.lostWithGuardOff}**`,
    `- USDC lost with the guard on: **${summary.lostWithGuardOn}**`,
    ...(summary.atRiskWithGuardOff !== undefined
      ? [
          `- USD at risk on Gemini with the guard off: **${summary.atRiskWithGuardOff}**`,
          `- USD at risk on Gemini with the guard on: **${summary.atRiskWithGuardOn}**`,
        ]
      : []),
    `- Honest purchases completed with the guard on: **${summary.honestCompletedWithGuard}**`,
    '',
    `| Scenario | Guard | Outcome | ${summary.atRiskWithGuardOff !== undefined ? 'Lost (USDC; USD at risk for M rows)' : 'USDC lost'} | Rule | Payment refs |`,
    '|---|---|---|---:|---|---|',
    ...results.rows.map((r) =>
      `| ${cell(r.attack)} | ${r.guardMode} | ${r.outcome} | ${r.usdcLost} | ${cell(r.guardMode === 'on' ? (r.rule ?? '') : '')} | ${cell(r.paymentRefs.slice(0, 3).join(', '))}${r.paymentRefs.length > 3 ? ` (+${r.paymentRefs.length - 3})` : ''} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

/** Writes results/redteam.json and results/redteam.md. Returns their paths. */
export function saveResults(guarded: SavedReport, baseline: SavedReport, dir: string = DEFAULT_RESULTS_DIR): { json: string; markdown: string; results: RedTeamResults } {
  const results = buildResults(guarded, baseline);
  mkdirSync(dir, { recursive: true });
  const json = join(dir, 'redteam.json');
  const markdown = join(dir, 'redteam.md');
  writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(markdown, renderResultsMarkdown(results));
  return { json, markdown, results };
}
