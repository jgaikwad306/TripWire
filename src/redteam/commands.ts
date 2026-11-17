import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { saveHtmlReport } from '../report/html.js';
import { explorerTxUrl, formatUsdc, parseUsdc } from '../constants.js';
import { ApprovalDesk } from '../guard/approvals.js';
import { JsonFileGuardStore } from '../guard/store.js';
import { startOwnerConsole } from '../owner/server.js';
import { renderComparison, renderMarkdown, renderTerminal } from '../report/render.js';
import { DEFAULT_REPORT_DIR, latestReportPath, loadReport, type SavedReport } from '../report/store.js';
import type { Address } from '../types.js';
import { ALL_SCENARIOS, findScenario, type RedTeamScenario } from './scenarios/index.js';
import { paidApiScenario } from './scenarios/paid-api.js';
import type { FacilitatorChoice } from './world.js';

import { AGENT_KINDS, createAgent, runOnce } from './service.js';
export { sweepHot } from './service.js';

const RUN_USAGE = `Usage: npm run cli run -- (--all | --scenario <id> ...) [options]

  --all               run every scenario
  --scenario <id>     run one scenario (repeatable)
  --fake              offline: in-memory ledger instead of Arc Testnet
  --no-guard          baseline: approve every payment and receipt
  --compare           run with the guard, then without, and compare
  --agent <kind>      ${AGENT_KINDS.join(' | ')} (default: grok if XAI_API_KEY and XAI_MODEL are set, else naive)
  --out <dir>         where reports are written (default: ${DEFAULT_REPORT_DIR})
  --facilitator <f>   on Arc, who settles x402 payments: circle (default; Circle's Facilitator
                      Service, falling back to local if its keyless trial runs out) | local
                      (the official x402 facilitator code run here, the merchant wallet pays gas)

Scenario ids: ${ALL_SCENARIOS.map((s) => s.id).join(', ')}`;

export interface CommandIo {
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Ends the process abruptly, for `buy --crash-after-send`. Tests replace it. */
  crash?: () => void;
}

/** sysexits "internal software error": the process stopped on purpose, mid-purchase. */
const CRASH_EXIT_CODE = 70;

const defaultIo = (): CommandIo => ({ log: (line) => console.log(line), env: process.env });

function selectScenarios(all: boolean, ids: readonly string[]): readonly RedTeamScenario[] {
  if (all && ids.length > 0) throw new Error('Use either --all or --scenario, not both.');
  if (all) return ALL_SCENARIOS;
  if (ids.length === 0) throw new Error(`Say what to run.\n\n${RUN_USAGE}`);
  return ids.map((id) => {
    const scenario = findScenario(id);
    if (!scenario) throw new Error(`Unknown scenario "${id}". Known ids: ${ALL_SCENARIOS.map((s) => s.id).join(', ')}`);
    return scenario;
  });
}

/** `npm run cli run` — runs red-team scenarios and writes a JSON + Markdown report. */
export async function runCommand(args: string[], io: CommandIo = defaultIo()): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      all: { type: 'boolean', default: false },
      scenario: { type: 'string', multiple: true, default: [] },
      fake: { type: 'boolean', default: false },
      'no-guard': { type: 'boolean', default: false },
      compare: { type: 'boolean', default: false },
      agent: { type: 'string' },
      out: { type: 'string', default: DEFAULT_REPORT_DIR },
      facilitator: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    io.log(RUN_USAGE);
    return;
  }
  const facilitator = parseFacilitator(values.facilitator ?? io.env.X402_FACILITATOR);
  if (values.compare && values['no-guard']) throw new Error('--compare already includes the no-guard run; drop --no-guard.');

  const base = {
    scenarios: selectScenarios(values.all, values.scenario),
    fake: values.fake,
    agent: createAgent(values.agent, io.env),
    outDir: values.out,
    io,
    ...(facilitator ? { facilitator } : {}),
  };
  if (!values.compare) {
    await runOnce({ ...base, guarded: !values['no-guard'] });
    return;
  }
  const guarded = await runOnce({ ...base, guarded: true });
  const baseline = await runOnce({ ...base, guarded: false });
  io.log(`\n${renderComparison(guarded.report, baseline.report)}`);
  io.log(`\nComparison page: ${saveHtmlReport(guarded, baseline, values.out)}`);
}

function parseFacilitator(value: string | undefined): FacilitatorChoice | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'circle' || value === 'local') return value;
  throw new Error(`Unknown facilitator "${value}". Use circle or local.`);
}

const scenarioKey = (saved: SavedReport): string =>
  [saved.network, saved.report.agentName, ...saved.report.results.map((r) => r.id).sort()].join('|');

/**
 * The newest guarded run and the newest unguarded run that covered the same scenarios
 * with the same agent on the same network, so the two can be shown side by side.
 */
export function latestPair(dir: string): { guarded: SavedReport; baseline: SavedReport } | undefined {
  if (!existsSync(dir)) return undefined;
  const saved: SavedReport[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort().reverse()) {
    try {
      saved.push(loadReport(join(dir, name)));
    } catch {
      // A file that is not a report is not this command's problem.
    }
  }
  for (const baseline of saved.filter((s) => !s.report.guarded)) {
    const guarded = saved.find((s) => s.report.guarded && scenarioKey(s) === scenarioKey(baseline));
    if (guarded) return { guarded, baseline };
  }
  return undefined;
}

/**
 * Two reports named on the command line, put in guarded/baseline order. The page calls
 * them "with the guard" and "without the guard" for "the same agent", so anything else
 * is refused rather than rendered as a comparison it is not.
 */
export function comparablePair(a: SavedReport, b: SavedReport): { guarded: SavedReport; baseline: SavedReport } {
  if (a.report.guarded === b.report.guarded) {
    throw new Error(`A comparison needs one run with the guard and one without; both of these ran ${a.report.guarded ? 'with' : 'without'} it.`);
  }
  if (scenarioKey(a) !== scenarioKey(b)) {
    throw new Error('A comparison needs two runs with the same agent, network and scenarios; these two differ.');
  }
  return a.report.guarded ? { guarded: a, baseline: b } : { guarded: b, baseline: a };
}

const DEFAULT_APPROVAL_WAIT_SECONDS = 120;
const DEFAULT_STATE_FILE = '.data/guard-state.json';

const BUY_USAGE =`Usage: npm run cli buy -- [options]

Buys a report of a wallet's recent USDC transfers from the paid API and answers from it.

  --address <0x…>     wallet to report on (default: the hot wallet; a sample wallet with --fake)
  --approve-above <usdc>  payments above this wait for you to approve them on a local page
  --approval-wait <s> how long a payment waits for your decision (default: ${DEFAULT_APPROVAL_WAIT_SECONDS})
  --crash-after-send  stop the process right after the payment is sent, before the guard hears back
  --resume            carry on after a crash: confirm the earlier payment and finish the purchase with it
  --state <file>      where the guard keeps its state for those two (default: ${DEFAULT_STATE_FILE})
  --fake              offline: in-memory ledger instead of Arc Testnet
  --no-guard          baseline: approve every payment and receipt
  --agent <kind>      ${AGENT_KINDS.join(' | ')} (default: grok if XAI_API_KEY and XAI_MODEL are set, else naive)
  --out <dir>         where reports are written (default: ${DEFAULT_REPORT_DIR})`;

function parseAddress(value: string | undefined): Address | undefined {
  if (value === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`--address "${value}" is not a valid address.`);
  return value.toLowerCase() as Address;
}

/**
 * `npm run cli buy` — the paid API workflow on its own: quote, guarded payment, receipt
 * check by the merchant, data delivered, and the agent's answer from that data.
 */
export async function buyCommand(args: string[], io: CommandIo = defaultIo()): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      address: { type: 'string' },
      'approve-above': { type: 'string' },
      'approval-wait': { type: 'string', default: String(DEFAULT_APPROVAL_WAIT_SECONDS) },
      'crash-after-send': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      state: { type: 'string', default: DEFAULT_STATE_FILE },
      fake: { type: 'boolean', default: false },
      'no-guard': { type: 'boolean', default: false },
      agent: { type: 'string' },
      out: { type: 'string', default: DEFAULT_REPORT_DIR },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    io.log(BUY_USAGE);
    return;
  }
  const activitySubject = parseAddress(values.address);
  const guarded = !values['no-guard'];
  const threshold = values['approve-above'] === undefined ? undefined : parseUsdc(values['approve-above']);
  const waitSeconds = Number(values['approval-wait']);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new Error(`--approval-wait "${values['approval-wait']}" is not a number of seconds.`);
  }
  if (threshold !== undefined && !guarded) {
    throw new Error('--approve-above needs the guard: without it nothing holds a payment for approval. Drop --no-guard.');
  }
  const crashing = values['crash-after-send'];
  const resuming = values.resume;
  if (crashing && resuming) throw new Error('Use one of --crash-after-send and --resume, not both.');
  if ((crashing || resuming) && !guarded) {
    throw new Error('--crash-after-send and --resume need the guard: it is the guard that keeps the state. Drop --no-guard.');
  }
  if (resuming && !existsSync(values.state)) {
    throw new Error(`Nothing to resume: there is no state file at ${values.state}. Run with --crash-after-send first.`);
  }
  // A crash demonstration starts clean, so an earlier run's payments do not count against it.
  if (crashing) rmSync(values.state, { force: true });
  const guardStore = crashing || resuming ? new JsonFileGuardStore(values.state) : undefined;
  // Read once here so an unreadable state file is reported before anything else happens.
  guardStore?.load();
  const afterPaymentSent = crashing
    ? (): void => {
        io.log('\nSimulating a crash: the payment has been sent, and the process stops before the guard hears back.');
        io.log('Run `npm run cli buy -- --resume` to carry on.');
        (io.crash ?? (() => process.exit(CRASH_EXIT_CODE)))();
      }
    : undefined;
  const agent = createAgent(values.agent, io.env);

  // The owner's page runs for the length of the purchase. Its address carries the token
  // that lets someone approve, so it goes to the terminal and nowhere the agent can read.
  const desk = threshold === undefined ? undefined : new ApprovalDesk();
  const owner = desk ? await startOwnerConsole(desk) : undefined;
  if (owner && threshold !== undefined) {
    io.log(`Owner approval page: ${owner.url}`);
    io.log(`Payments above ${formatUsdc(threshold)} USDC wait there for your decision, for up to ${waitSeconds} seconds.`);
  }
  let saved: SavedReport;
  try {
    saved = await runOnce({
      scenarios: [paidApiScenario],
      guarded,
      fake: values.fake,
      agent,
      outDir: values.out,
      io,
      ...(activitySubject ? { activitySubject } : {}),
      ...(desk && threshold !== undefined ? { approval: { threshold, desk, waitMs: waitSeconds * 1000 } } : {}),
      ...(guardStore ? { guardStore } : {}),
      ...(afterPaymentSent ? { afterPaymentSent } : {}),
    });
  } finally {
    await owner?.close();
  }

  const result = saved.report.results[0];
  const answer = [...(result?.transcript ?? [])].reverse().find((entry) => entry.kind === 'agent');
  io.log(`\nAnswer: ${answer && 'text' in answer ? answer.text : (result?.notes ?? 'The agent gave no answer.')}`);
  for (const txHash of result?.txHashes ?? []) {
    io.log(`Payment: ${txHash}${saved.network === 'arc-testnet' ? `  ${explorerTxUrl(txHash)}` : ''}`);
  }
}

/** Shortcut commands run every scenario unless the caller picks some. */
export function withDefaultAll(flag: '--no-guard' | '--compare', args: readonly string[]): string[] {
  const picksScenarios = args.some((a) => a === '--all' || a === '--scenario' || a.startsWith('--scenario=') || a === '--help');
  return [...(picksScenarios ? [] : ['--all']), flag, ...args];
}

/** `npm run cli no-guard [run options]` — the unprotected baseline: `run --all --no-guard`. */
export const noGuardCommand = (args: string[], io?: CommandIo): Promise<void> =>
  runCommand(withDefaultAll('--no-guard', args), io);

/** `npm run cli compare [run options]` — guarded then unguarded: `run --all --compare`. */
export const compareCommand = (args: string[], io?: CommandIo): Promise<void> =>
  runCommand(withDefaultAll('--compare', args), io);

/**
 * `npm run cli report [path] [baselinePath]` — re-renders a saved report (the latest by default).
 * `--html` writes the page instead: for the given report(s), or with no path for the newest
 * guarded and unguarded runs over the same scenarios.
 */
export async function reportCommand(args: string[], io: CommandIo = defaultIo()): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', default: DEFAULT_REPORT_DIR },
      markdown: { type: 'boolean', default: false },
      html: { type: 'boolean', default: false },
    },
  });
  if (values.html) {
    const pair = positionals.length === 0 ? latestPair(values.out) : undefined;
    const primaryPath = positionals[0] ?? latestReportPath(values.out);
    if (!pair && !primaryPath) throw new Error(`No reports in ${values.out}/ yet. Run \`npm run cli run -- --all --fake\` first.`);
    if (pair) {
      io.log(`Page: ${saveHtmlReport(pair.guarded, pair.baseline, values.out)}`);
      return;
    }
    const first = loadReport(primaryPath!);
    if (!positionals[1]) {
      io.log(`Page: ${saveHtmlReport(first, undefined, values.out)}`);
      return;
    }
    const chosen = comparablePair(first, loadReport(positionals[1]));
    io.log(`Page: ${saveHtmlReport(chosen.guarded, chosen.baseline, values.out)}`);
    return;
  }
  const path = positionals[0] ?? latestReportPath(values.out);
  if (!path) throw new Error(`No reports in ${values.out}/ yet. Run \`npm run cli run -- --all --fake\` first.`);
  const saved = loadReport(path);
  io.log(values.markdown ? renderMarkdown(saved) : `${renderTerminal(saved)}\n\nFrom ${path}`);
}
