import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionEvent } from '../events.js';
import { runOnce } from '../redteam/service.js';
import { agentChoices, agentSecretEnv, createAgent, loadAgentRegistry, type AgentChoice, type AgentRegistry } from '../agent/registry.js';
import { executionOrder } from '../redteam/runner.js';
import { ALL_SCENARIOS } from '../redteam/scenarios/index.js';
import { jsonSafe } from '../redteam/scenarios/helpers.js';
import { DEFAULT_REPORT_DIR, type SavedReport } from '../report/store.js';
import { saveHtmlReport } from '../report/html.js';
import { FOCUSED_SCENARIOS, scenarioCatalog } from './catalog.js';
import { streamsEnabled } from '../streams/client.js';
import { saveJournal, type RunJournal } from './journal.js';

/** Longest pause a replay keeps between two recorded events, before speed-up. */
const MAX_REPLAY_GAP_MS = 2_000;

export const runConfigSchema = z.object({
  scenarioIds: z.array(z.string()).min(1).max(ALL_SCENARIOS.length).refine((ids) => new Set(ids).size === ids.length, 'Select each scenario once.'),
  network: z.enum(['arc-testnet', 'fake']),
  /** A built-in agent or one from agents.json; checked against the registry when a run starts. */
  agent: z.string().min(1).max(64),
});
export type RunConfig = z.infer<typeof runConfigSchema>;
export type Phase = 'guarded' | 'unguarded';
export interface LiveEvent {
  sequence: number;
  runId: string;
  timestamp: string;
  phase?: Phase;
  scenarioId?: string;
  type: ExecutionEvent['type'] | 'run.started' | 'phase.started' | 'phase.completed' | 'run.log' | 'run.stopping' | 'run.completed' | 'run.failed';
  data: unknown;
}
export interface LiveRun {
  id: string;
  status: 'running' | 'stopping' | 'completed' | 'partial' | 'failed';
  config: RunConfig;
  queue: string[];
  events: LiveEvent[];
  sequence: number;
  phase?: Phase;
  scenarioId?: string;
  reports: Partial<Record<Phase, SavedReport>>;
  error?: string;
  /** Shown above the run, e.g. that it is a replay of a recording. */
  warning?: string;
}
export class DashboardError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function missingConfiguration(config: RunConfig, env: NodeJS.ProcessEnv, agents: AgentChoice[] = agentChoices({ specs: [] })): string[] {
  const keys: string[] = [...(agents.find((a) => a.id === config.agent)?.requiredEnv ?? [])];
  if (config.network === 'arc-testnet') {
    keys.push('CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'WALLET_ID_HOT', 'WALLET_ID_VAULT', 'WALLET_ID_MERCHANT', 'ATTACKER_PRIVATE_KEY');
    if (config.scenarioIds.includes('counterfeit-usdc')) keys.push('FAKE_USDC_ADDRESS');
  }
  return keys.filter((key) => !env[key]);
}

/** One local run at a time: Arc scenarios share the real wallets. */
export class RunManager {
  run?: LiveRun;
  private stopping = false;
  private task?: Promise<void>;
  private listeners = new Set<(event: LiveEvent) => void>();
  readonly env: NodeJS.ProcessEnv;
  readonly outDir: string;
  readonly registry: AgentRegistry;
  readonly agents: AgentChoice[];

  constructor(private readonly options: {
    env?: NodeJS.ProcessEnv;
    outDir?: string;
    defaults?: Partial<RunConfig>;
    execute?: typeof runOnce;
    /** Replay this recording instead of executing anything. */
    replay?: { journal: RunJournal; speed?: number };
    /** Save a recording of each finished run (default true outside replay). */
    record?: boolean;
    /** Custom agents. Defaults to agents.json (or TRIPWIRE_AGENTS_FILE). */
    registry?: AgentRegistry;
  } = {}) {
    this.env = options.env ?? process.env;
    this.outDir = options.outDir ?? DEFAULT_REPORT_DIR;
    // A replay executes nothing, so a broken agents file must not stop it.
    this.registry = options.registry ?? (options.replay ? safeRegistry(this.env) : loadAgentRegistry(this.env));
    this.agents = agentChoices(this.registry);
  }

  config() {
    const recorded = this.options.replay?.journal.run.config;
    const defaults: RunConfig = recorded ?? { scenarioIds: FOCUSED_SCENARIOS, network: 'arc-testnet', agent: 'grok', ...this.options.defaults };
    // Only readiness booleans/names cross the boundary, never environment values.
    // A replay needs no keys: it executes nothing.
    const replaying = Boolean(this.options.replay);
    const keys = new Set(['XAI_API_KEY', 'XAI_MODEL', 'CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'WALLET_ID_HOT', 'WALLET_ID_VAULT', 'WALLET_ID_MERCHANT', 'ATTACKER_PRIVATE_KEY', 'FAKE_USDC_ADDRESS', ...this.agents.flatMap((a) => a.requiredEnv)]);
    return { defaults, scenarios: scenarioCatalog(), agents: this.agents, model: this.env.XAI_MODEL ?? null, streamsEnabled: !replaying && streamsEnabled(this.env), replay: replaying,
      configured: Object.fromEntries([...keys].map((key) => [key, replaying || Boolean(this.env[key])])) };
  }

  snapshot() { return { run: this.run ?? null }; }
  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(input: unknown): LiveRun {
    if (this.run && ['running', 'stopping'].includes(this.run.status)) throw new DashboardError('A comparison is already running.', 409);
    if (this.options.replay) return this.startReplay(this.options.replay);
    const parsed = runConfigSchema.safeParse(input);
    if (!parsed.success) throw new DashboardError(parsed.error.issues.map((i) => i.message).join(' '));
    const config = parsed.data;
    if (config.scenarioIds.some((id) => !ALL_SCENARIOS.some((s) => s.id === id))) throw new DashboardError('Unknown scenario selected.');
    if (!this.agents.some((a) => a.id === config.agent)) throw new DashboardError(`Unknown agent "${config.agent}".`);
    const missing = missingConfiguration(config, this.env, this.agents);
    if (missing.length) throw new DashboardError(`Configure ${missing.join(', ')} in .env, then restart the dashboard.`, 422);
    const scenarios = executionOrder(ALL_SCENARIOS.filter((s) => config.scenarioIds.includes(s.id)));
    this.stopping = false;
    this.run = { id: randomUUID(), status: 'running', config, queue: scenarios.map((s) => s.id), events: [], sequence: 0, reports: {} };
    this.task = this.execute(this.run);
    return this.run;
  }

  /** Plays a recorded run back through the same event stream, with its original pacing. Nothing executes. */
  private startReplay(replay: { journal: RunJournal; speed?: number }): LiveRun {
    const recorded = replay.journal.run;
    this.stopping = false;
    this.run = {
      id: randomUUID(), status: 'running', config: recorded.config, queue: [...recorded.queue], events: [], sequence: 0, reports: {},
      warning: `Replay of ${recorded.config.network === 'fake' ? 'an offline' : 'a live Arc Testnet'} run recorded ${replay.journal.recordedAt}. Nothing is executed and no funds move.`,
    };
    const run = this.run;
    this.task = (async () => {
      let previous: number | undefined;
      for (const event of recorded.events) {
        if (this.stopping) break;
        const at = Date.parse(event.timestamp);
        if (previous !== undefined && at > previous) await new Promise((r) => setTimeout(r, Math.min(MAX_REPLAY_GAP_MS, at - previous!) / (replay.speed ?? 1)));
        previous = at;
        if (event.type === 'phase.started') { run.phase = event.phase; run.scenarioId = undefined; }
        if (event.type === 'scenario.started') run.scenarioId = event.scenarioId;
        if (event.type === 'phase.completed' && event.phase && recorded.reports[event.phase]) run.reports[event.phase] = recorded.reports[event.phase]!;
        if (event.type === 'run.completed') { run.status = recorded.status === 'completed' ? 'completed' : 'partial'; run.scenarioId = undefined; }
        if (event.type === 'run.failed') { run.status = 'failed'; run.error = recorded.error ?? 'The recorded run failed.'; }
        this.publish(event.type, event.data, event.phase, event.scenarioId);
      }
      if (run.status === 'running' || run.status === 'stopping') {
        run.status = 'partial';
        this.publish('run.completed', { status: run.status });
      }
    })();
    return run;
  }

  stop(id: string): void {
    if (this.run?.id !== id) throw new DashboardError('Run not found.', 404);
    if (!['running', 'stopping'].includes(this.run.status)) throw new DashboardError('This run has already finished.', 409);
    this.stopping = true;
    this.run.status = 'stopping';
    this.publish('run.stopping', { message: 'Finishing the current scenario and measuring its outcome.' });
  }

  async close(): Promise<void> {
    if (this.run && ['running', 'stopping'].includes(this.run.status)) this.stop(this.run.id);
    await this.task;
  }

  private publish(type: LiveEvent['type'], data: unknown, phase?: Phase, scenarioId?: string): void {
    const run = this.run!;
    // Tool replies may contain attacker text. Copy and redact before retaining/broadcasting.
    const agentSecrets = new Set(agentSecretEnv(this.registry));
    const secrets = Object.entries(this.env).filter(([key, value]) => (/API_KEY|SECRET|PRIVATE_KEY/.test(key) || agentSecrets.has(key)) && value).map(([, value]) => value!);
    const safe = JSON.parse(JSON.stringify(jsonSafe(data), (_key, value: unknown) => {
      if (typeof value !== 'string') return value;
      return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
    })) as unknown;
    const event: LiveEvent = { sequence: ++run.sequence, runId: run.id, timestamp: new Date().toISOString(), type, data: safe, ...(phase ? { phase } : {}), ...(scenarioId ? { scenarioId } : {}) };
    run.events.push(event);
    for (const listener of this.listeners) { try { listener(event); } catch { /* A viewer is not part of execution. */ } }
  }

  private async execute(run: LiveRun): Promise<void> {
    this.publish('run.started', { queue: run.queue });
    try {
      const agent = await createAgent(run.config.agent, this.env, this.registry);
      for (const phase of ['guarded', 'unguarded'] as const) {
        if (this.stopping) break;
        run.phase = phase;
        run.scenarioId = undefined;
        this.publish('phase.started', {}, phase);
        const saved = await (this.options.execute ?? runOnce)({
          scenarios: ALL_SCENARIOS.filter((s) => run.queue.includes(s.id)), guarded: phase === 'guarded',
          fake: run.config.network === 'fake', agent, outDir: this.outDir,
          io: { env: this.env, log: (message) => this.publish('run.log', { message }, phase) },
          observer: {
            shouldStop: () => this.stopping,
            onEvent: (scenarioId, event) => {
              if (event.type === 'scenario.started') run.scenarioId = scenarioId;
              this.publish(event.type, event.data, phase, scenarioId);
            },
          },
        });
        run.reports[phase] = saved;
        const { results: _results, ...summary } = saved.report;
        this.publish('phase.completed', { report: summary, partial: Boolean(saved.partial) }, phase);
      }
      const complete = Object.values(run.reports).length === 2 && Object.values(run.reports).every((s) => !s.partial && s.report.results.length === run.queue.length);
      run.status = complete ? 'completed' : 'partial';
      if (complete) saveHtmlReport(run.reports.guarded!, run.reports.unguarded!, this.outDir);
      run.scenarioId = undefined;
      this.publish('run.completed', { status: run.status });
    } catch (err) {
      run.status = 'failed';
      // Errors follow the same secret-redacting event path as tool results.
      this.publish('run.failed', { message: err instanceof Error ? err.message : String(err) });
      run.error = (run.events.at(-1)!.data as { message: string }).message;
    }
    // A recording for `npm run demo:replay`. Events were redacted as they were published.
    if (this.options.record ?? !this.options.execute) {
      // Saved after run.completed, which stays the last event a viewer receives.
      try { saveJournal(run, this.outDir); }
      catch { /* A recording is a convenience; the run itself is done. */ }
    }
  }
}

function safeRegistry(env: NodeJS.ProcessEnv): AgentRegistry {
  try { return loadAgentRegistry(env); } catch { return { specs: [] }; }
}
