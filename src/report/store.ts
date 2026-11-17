import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Report, TxHash } from '../types.js';

export type Network = 'fake' | 'arc-testnet';

/** What a report file holds: the report plus where it was run. */
export interface SavedReport {
  network: Network;
  report: Report;
}

export const DEFAULT_REPORT_DIR = 'reports';

/** USDC amounts are bigint in memory and base-unit decimal strings on disk. */
const usdcSchema = z
  .string()
  .regex(/^\d+$/, 'must be base units as a decimal string')
  .transform((value) => BigInt(value));

const txHashSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]+$/)
  .transform((value) => value as TxHash);

const decisionSchema = z.object({
  allowed: z.boolean(),
  check: z.string(),
  reason: z.string(),
  txHash: txHashSchema.optional(),
});

const categorySchema = z.enum(['send', 'hold', 'receive', 'honest']);
const categoryScoreSchema = z.object({ passed: z.number(), total: z.number(), score: z.number() });

const resultSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: categorySchema,
  expected: z.enum(['blocked', 'completed']),
  passed: z.boolean(),
  usdcLost: usdcSchema,
  txHashes: z.array(txHashSchema),
  decisions: z.array(decisionSchema),
  notes: z.string().optional(),
  error: z.string().optional(),
});

const savedReportSchema = z.object({
  network: z.enum(['fake', 'arc-testnet']),
  report: z.object({
    agentName: z.string(),
    guarded: z.boolean(),
    startedAt: z.string(),
    overall: z.number(),
    byCategory: z.object({
      send: categoryScoreSchema,
      hold: categoryScoreSchema,
      receive: categoryScoreSchema,
      honest: categoryScoreSchema,
    }),
    usdcLost: usdcSchema,
    honestCompleted: z.number(),
    honestTotal: z.number(),
    results: z.array(resultSchema),
  }),
});

export function serializeReport(saved: SavedReport): string {
  return JSON.stringify(saved, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2);
}

export function parseReport(text: string): SavedReport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Report is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = savedReportSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Report file has an unexpected shape: ${issues}`);
  }
  return result.data;
}

const fileStem = (saved: SavedReport): string =>
  `${saved.report.startedAt.replace(/[:.]/g, '-')}-${saved.report.guarded ? 'guarded' : 'no-guard'}`;

/** Writes `<timestamp>-<guarded|no-guard>.json` and `.md` side by side. */
export function saveReport(
  saved: SavedReport,
  markdown: string,
  dir: string = DEFAULT_REPORT_DIR,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `${fileStem(saved)}.json`);
  const markdownPath = join(dir, `${fileStem(saved)}.md`);
  writeFileSync(jsonPath, serializeReport(saved));
  writeFileSync(markdownPath, markdown);
  return { jsonPath, markdownPath };
}

export function loadReport(path: string): SavedReport {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read report ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseReport(text);
}

/** Most recent report in the directory (file names start with the timestamp), if any. */
export function latestReportPath(dir: string = DEFAULT_REPORT_DIR): string | undefined {
  if (!existsSync(dir)) return undefined;
  const newest = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .at(-1);
  return newest ? join(dir, newest) : undefined;
}
