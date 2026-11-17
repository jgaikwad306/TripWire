import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { saveHtmlReport } from '../report/html.js';
import { CAREFUL_SYSTEM_PROMPT, GrokAgent } from '../agent/grok.js';
import { ARC_TESTNET, formatUsdc } from '../constants.js';
import { describeResult, renderComparison, renderMarkdown, renderTerminal } from '../report/render.js';
import { DEFAULT_REPORT_DIR, latestReportPath, loadReport, saveReport, type HoldSnapshot, type SavedReport } from '../report/store.js';
import type { Agent } from '../types.js';
import { NaiveAgent } from './naive-agent.js';
import { runScenarios } from './runner.js';
import { ALL_SCENARIOS, findScenario, type RedTeamScenario } from './scenarios/index.js';
import { buildReport } from './score.js';
import { fakeWorldFactory, liveWorldFactory, runPolicy, type World, type WorldFactory } from './world.js';

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
}

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
async function checkWorld(makeWorld: WorldFactory, guarded: boolean, io: CommandIo): Promise<HoldSnapshot | undefined> {
  const world = await makeWorld();
  try {
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
    if (!guarded) return undefined;
    return {
      hotCap: runPolicy(world.wallet, world.prices).hotBalanceCap,
      hot,
      vault: await world.wallet.getBalance('vault'),
      swept,
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
}): Promise<SavedReport> {
  const { scenarios, guarded, fake, agent, outDir, io } = opts;
  const worldOptions = { guarded, agent };
  const makeWorld = fake ? fakeWorldFactory(worldOptions) : liveWorldFactory(worldOptions, io.env);
  const hold = await checkWorld(makeWorld, guarded, io);

  io.log(`\nRunning ${scenarios.length} scenario(s): agent ${agent.name}, guard ${guarded ? 'ON' : 'OFF'}, ${fake ? 'fake ledger' : 'Arc Testnet'}`);
  const startedAt = new Date().toISOString();
  const results = await runScenarios(scenarios, makeWorld, (r) =>
    io.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.title}: ${describeResult(r)}`),
  );

  const saved: SavedReport = {
    network: fake ? 'fake' : 'arc-testnet',
    report: buildReport(results, { agentName: agent.name, guarded, startedAt }),
    ...(hold ? { hold } : {}),
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
    const primary = pair?.guarded ?? loadReport(primaryPath!);
    const baseline = pair?.baseline ?? (positionals[1] ? loadReport(positionals[1]) : undefined);
    io.log(`Page: ${saveHtmlReport(primary, baseline, values.out)}`);
    return;
  }
  const path = positionals[0] ?? latestReportPath(values.out);
  if (!path) throw new Error(`No reports in ${values.out}/ yet. Run \`npm run cli run -- --all --fake\` first.`);
  const saved = loadReport(path);
  io.log(values.markdown ? renderMarkdown(saved) : `${renderTerminal(saved)}\n\nFrom ${path}`);
}
