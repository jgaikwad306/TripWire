import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Address, Report, TxHash, Usdc } from '../types.js';

export type Network = 'fake' | 'arc-testnet';

/**
 * The hold rule as it stood when a guarded run began: how much the agent could spend
 * and how much sat in the vault beyond its reach.
 */
export interface HoldSnapshot {
  /** The most the hot wallet may hold; the guard sweeps anything above it. */
  hotCap: Usdc;
  hot: Usdc;
  vault: Usdc;
  /** Moved from the hot wallet to the vault just before this run. */
  swept: Usdc;
}

/** Whose address is whose, so a replay can label the attacker's address where it appears. */
export interface Parties {
  merchant: Address;
  attacker: Address;
}

/** What a report file holds: the report plus where it was run. */
export interface SavedReport {
  network: Network;
  report: Report;
  /** Present in reports saved since replays were added. */
  parties?: Parties;
  /** Present for guarded runs recorded since the hold rule was added to reports. */
  hold?: HoldSnapshot;
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

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase() as Address);

const transcriptEntrySchema = z.union([
  z.object({ kind: z.enum(['task', 'agent', 'attacker', 'merchant']), text: z.string() }),
  // Tool arguments and results are whatever the tool exchanged; the page escapes them.
  z.object({ kind: z.literal('tool'), name: z.string(), args: z.unknown(), result: z.unknown() }),
]);

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
  transcript: z.array(transcriptEntrySchema).optional(),
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
  hold: z.object({ hotCap: usdcSchema, hot: usdcSchema, vault: usdcSchema, swept: usdcSchema }).optional(),
  parties: z.object({ merchant: addressSchema, attacker: addressSchema }).optional(),
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
