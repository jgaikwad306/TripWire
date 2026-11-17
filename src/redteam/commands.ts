import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { saveHtmlReport } from '../report/html.js';
import { CAREFUL_SYSTEM_PROMPT, GrokAgent } from '../agent/grok.js';
import { ARC_TESTNET, explorerTxUrl, formatUsdc, parseUsdc } from '../constants.js';
import { ApprovalDesk } from '../guard/approvals.js';
import { JsonFileGuardStore } from '../guard/store.js';
import { startOwnerConsole } from '../owner/server.js';
import { describeResult, renderComparison, renderMarkdown, renderTerminal } from '../report/render.js';
import { DEFAULT_REPORT_DIR, latestReportPath, loadReport, saveReport, type HoldSnapshot, type Parties, type SavedReport } from '../report/store.js';
import type { Address, Agent } from '../types.js';
import { NaiveAgent } from './naive-agent.js';
import { runScenarios } from './runner.js';
import { ALL_SCENARIOS, findScenario, type RedTeamScenario } from './scenarios/index.js';
import { paidApiScenario } from './scenarios/paid-api.js';
import { buildReport } from './score.js';
import { fakeWorldFactory, liveWorldFactory, runPolicy, type World, type WorldFactory, type WorldOptions } from './world.js';

const AGENT_KINDS = ['naive', 'grok', 'grok-careful'] as const;
type AgentKind = (typeof AGENT_KINDS)[number];

const RUN_USAGE = `Usage: npm run cli run -- (--all | --scenario <id> ...) [options]

  --all               run every scenario
  --scenario <id>     run one scenario (repeatable)
  --fake              offline: in-memory ledger instead of Arc Testnet
  --no-guard          baseline: approve every payment and receipt
  --compare           run with the guard, then without, and compare
  --agent <kind>      ${AGENT_KINDS.join(' | ')} (default: grok if XAI_API_KEY and XAI_MODEL are set, else naive)
  --out <dir>         where reports are written (default: ${DEFAULT_REPORT_DIR})

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

function createAgent(requested: string | undefined, env: NodeJS.ProcessEnv): Agent {
  const kind = requested ?? (env.XAI_API_KEY && env.XAI_MODEL ? 'grok' : 'naive');
  if (!AGENT_KINDS.includes(kind as AgentKind)) {
    throw new Error(`Unknown agent "${kind}". Choose one of: ${AGENT_KINDS.join(', ')}`);
  }
  if (kind === 'naive') return new NaiveAgent();
  if (kind === 'grok') return new GrokAgent();
  return new GrokAgent({ systemPrompt: CAREFUL_SYSTEM_PROMPT, name: `grok-careful:${env.XAI_MODEL ?? ''}` });
}

/** A full run spends a few datasets' worth from the hot wallet (honest buys plus customer payments). */
const HOT_BALANCE_NEEDED_IN_DATASETS = 3n;

/**
 * The "hold" rule: before a run, the guard moves anything above the hot wallet's cap
 * into the vault, so the agent only ever has the capped amount within reach. Without a
 * guard this does nothing, which is the point of the baseline. Returns the amount swept.
 * A failed sweep is reported but does not stop the run.
 */
export async function sweepHot(world: World, io: CommandIo): Promise<bigint> {
  // Measured at the vault: the hot wallet also pays gas, so its drop overstates the sweep.
  const before = await world.wallet.getBalance('vault');
  try {
    await world.guard.rebalance();
  } catch (err) {
    io.log(`WARNING: could not sweep the hot wallet: ${err instanceof Error ? err.message : String(err)}`);
    return 0n;
  }
  const swept = (await world.wallet.getBalance('vault')) - before;
  if (swept > 0n) {
    io.log(`Hold: swept ${formatUsdc(swept)} USDC from the hot wallet to the vault ${world.wallet.addressOf('vault')}.`);
  }
  return swept > 0n ? swept : 0n;
}

/**
 * Builds one world up front so missing keys or wallets fail once, clearly, before any
 * scenario runs. On Arc it also reports the hot balance, because an earlier no-guard
 * run may have drained it and every scenario shares that wallet.
 */
async function checkWorld(
  makeWorld: WorldFactory,
  guarded: boolean,
  io: CommandIo,
): Promise<{ hold?: HoldSnapshot; parties: Parties }> {
  const world = await makeWorld();
  try {
    const parties: Parties = { merchant: world.wallet.addressOf('merchant'), attacker: world.attacker };
    // Offline every scenario starts from a fresh ledger, so there is nothing to sweep.
    const swept = world.network === 'fake' ? 0n : await sweepHot(world, io);
    const hot = await world.wallet.getBalance('hot');
    if (world.network !== 'fake') {
      io.log(`Hot wallet ${world.wallet.addressOf('hot')} holds ${formatUsdc(hot)} USDC.`);
      if (hot < world.prices.dataset * HOT_BALANCE_NEEDED_IN_DATASETS) {
        io.log(`WARNING: that is low for a full run. Top it up at ${ARC_TESTNET.faucetUrl} or expect failed purchases.`);
      }
    }
    // Without a guard nothing enforces a cap, so there is no hold rule to record.
    if (!guarded) return { parties };
    return {
      parties,
      hold: {
        hotCap: runPolicy(world.wallet, world.prices).hotBalanceCap,
        hot,
        vault: await world.wallet.getBalance('vault'),
        swept,
      },
    };
  } finally {
    await world.close();
  }
}

async function runOnce(opts: {
  scenarios: readonly RedTeamScenario[];
  guarded: boolean;
  fake: boolean;
  agent: Agent;
  outDir: string;
  io: CommandIo;
  activitySubject?: Address;
  approval?: WorldOptions['approval'];
  guardStore?: WorldOptions['guardStore'];
  afterPaymentSent?: WorldOptions['afterPaymentSent'];
}): Promise<SavedReport> {
  const { scenarios, guarded, fake, agent, outDir, io, activitySubject, approval, guardStore, afterPaymentSent } = opts;
  const worldOptions: WorldOptions = {
    guarded,
    agent,
    ...(activitySubject ? { activitySubject } : {}),
    ...(approval ? { approval } : {}),
    ...(guardStore ? { guardStore } : {}),
    ...(afterPaymentSent ? { afterPaymentSent } : {}),
  };
  const makeWorld = fake ? fakeWorldFactory(worldOptions) : liveWorldFactory(worldOptions, io.env);
  const { hold, parties } = await checkWorld(makeWorld, guarded, io);

  io.log(`\nRunning ${scenarios.length} scenario(s): agent ${agent.name}, guard ${guarded ? 'ON' : 'OFF'}, ${fake ? 'fake ledger' : 'Arc Testnet'}`);
  const startedAt = new Date().toISOString();
  const results = await runScenarios(scenarios, makeWorld, (r) =>
    io.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.title}: ${describeResult(r)}`),
  );

  const saved: SavedReport = {
    network: fake ? 'fake' : 'arc-testnet',
    report: buildReport(results, { agentName: agent.name, guarded, startedAt }),
    ...(hold ? { hold } : {}),
    parties,
    ...(approval
      ? {
          approvals: approval.desk.list().map((a) => ({
            item: a.item,
            merchantUrl: a.merchantUrl,
            payTo: a.payTo,
            amount: a.amount,
            status: a.status,
          })),
        }
      : {}),
  };
  const paths = saveReport(saved, renderMarkdown(saved), outDir);
  const htmlPath = saveHtmlReport(saved, undefined, outDir);
  io.log(`\n${renderTerminal(saved)}\n\nReport written to ${paths.markdownPath} and ${paths.jsonPath}\nPage: ${htmlPath}`);
  return saved;
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
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    io.log(RUN_USAGE);
    return;
  }
  if (values.compare && values['no-guard']) throw new Error('--compare already includes the no-guard run; drop --no-guard.');

  const base = {
    scenarios: selectScenarios(values.all, values.scenario),
    fake: values.fake,
    agent: createAgent(values.agent, io.env),
    outDir: values.out,
    io,
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
