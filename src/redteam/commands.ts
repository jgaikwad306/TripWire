import { parseArgs } from 'node:util';
import { CAREFUL_SYSTEM_PROMPT, GrokAgent } from '../agent/grok.js';
import { ARC_TESTNET, formatUsdc } from '../constants.js';
import { describeResult, renderComparison, renderMarkdown, renderTerminal } from '../report/render.js';
import { DEFAULT_REPORT_DIR, latestReportPath, loadReport, saveReport, type SavedReport } from '../report/store.js';
import type { Agent } from '../types.js';
import { NaiveAgent } from './naive-agent.js';
import { runScenarios } from './runner.js';
import { ALL_SCENARIOS, findScenario, type RedTeamScenario } from './scenarios/index.js';
import { buildReport } from './score.js';
import { fakeWorldFactory, liveWorldFactory, type WorldFactory } from './world.js';

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
 * Builds one world up front so missing keys or wallets fail once, clearly, before any
 * scenario runs. On Arc it also reports the hot balance, because an earlier no-guard
 * run may have drained it and every scenario shares that wallet.
 */
async function checkWorld(makeWorld: WorldFactory, io: CommandIo): Promise<void> {
  const world = await makeWorld();
  try {
    if (world.network === 'fake') return;
    const hot = await world.wallet.getBalance('hot');
    io.log(`Hot wallet ${world.wallet.addressOf('hot')} holds ${formatUsdc(hot)} USDC.`);
    if (hot < world.prices.dataset * HOT_BALANCE_NEEDED_IN_DATASETS) {
      io.log(`WARNING: that is low for a full run. Top it up at ${ARC_TESTNET.faucetUrl} or expect failed purchases.`);
    }
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
  await checkWorld(makeWorld, io);

  io.log(`\nRunning ${scenarios.length} scenario(s): agent ${agent.name}, guard ${guarded ? 'ON' : 'OFF'}, ${fake ? 'fake ledger' : 'Arc Testnet'}`);
  const startedAt = new Date().toISOString();
  const results = await runScenarios(scenarios, makeWorld, (r) =>
    io.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.title}: ${describeResult(r)}`),
  );

  const saved: SavedReport = {
    network: fake ? 'fake' : 'arc-testnet',
    report: buildReport(results, { agentName: agent.name, guarded, startedAt }),
  };
  const paths = saveReport(saved, renderMarkdown(saved), outDir);
  io.log(`\n${renderTerminal(saved)}\n\nReport written to ${paths.markdownPath} and ${paths.jsonPath}`);
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
}

/** `npm run cli report [path]` — re-renders a saved report (the latest one by default). */
export async function reportCommand(args: string[], io: CommandIo = defaultIo()): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { out: { type: 'string', default: DEFAULT_REPORT_DIR }, markdown: { type: 'boolean', default: false } },
  });
  const path = positionals[0] ?? latestReportPath(values.out);
  if (!path) throw new Error(`No reports in ${values.out}/ yet. Run \`npm run cli run -- --all --fake\` first.`);
  const saved = loadReport(path);
  io.log(values.markdown ? renderMarkdown(saved) : `${renderTerminal(saved)}\n\nFrom ${path}`);
}
