import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReport, serializeReport, type SavedReport } from '../report/store.js';
import type { LiveRun, Phase } from './manager.js';

/** A recorded dashboard run: every event in order, plus the reports it produced. Replayable offline. */
export interface RunJournal {
  version: 1;
  recordedAt: string;
  run: LiveRun;
}

/** Where journals go, under the report directory. */
export const journalDir = (outDir: string): string => join(outDir, 'runs');

/** A recording bundled with the repo, for a stage with no wifi. */
export const BUNDLED_JOURNAL = join('recordings', 'demo.journal.json');

export function saveJournal(run: LiveRun, outDir: string, now = new Date()): string {
  const dir = journalDir(outDir);
  mkdirSync(dir, { recursive: true });
  const reports = Object.fromEntries(Object.entries(run.reports).map(([phase, saved]) => [phase, JSON.parse(serializeReport(saved))]));
  const journal = { version: 1, recordedAt: now.toISOString(), run: { ...run, reports } };
  const path = join(dir, `${now.toISOString().replace(/[:.]/g, '-')}-${run.config.network}.journal.json`);
  writeFileSync(path, JSON.stringify(journal, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)));
  return path;
}

export function loadJournal(path: string): RunJournal {
  let raw: { version?: unknown; recordedAt?: unknown; run?: LiveRun & { reports: Record<string, unknown> } };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as typeof raw;
  } catch (err) {
    throw new Error(`Could not read the recording ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw.version !== 1 || typeof raw.recordedAt !== 'string' || !raw.run || !Array.isArray(raw.run.events) || !Array.isArray(raw.run.queue)) {
    throw new Error(`${path} is not a Tripwire run recording.`);
  }
  const reports: Partial<Record<Phase, SavedReport>> = {};
  for (const [phase, saved] of Object.entries(raw.run.reports ?? {})) {
    if (phase === 'guarded' || phase === 'unguarded') reports[phase] = parseReport(JSON.stringify(saved));
  }
  return { version: 1, recordedAt: raw.recordedAt, run: { ...raw.run, reports } };
}

/** The newest recording in the report directory, else the bundled one. */
export function latestJournal(outDir: string): string | undefined {
  const dir = journalDir(outDir);
  const newest = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.journal.json')).sort().at(-1) : undefined;
  if (newest) return join(dir, newest);
  return existsSync(BUNDLED_JOURNAL) ? BUNDLED_JOURNAL : undefined;
}
