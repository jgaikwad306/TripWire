import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionEvent } from '../events.js';
import { runOnce, createAgent, AGENT_KINDS } from '../redteam/service.js';
import { executionOrder } from '../redteam/runner.js';
import { ALL_SCENARIOS } from '../redteam/scenarios/index.js';
import { jsonSafe } from '../redteam/scenarios/helpers.js';
import { DEFAULT_REPORT_DIR, type SavedReport } from '../report/store.js';
import { saveHtmlReport } from '../report/html.js';
import { FOCUSED_SCENARIOS, scenarioCatalog } from './catalog.js';
import { streamsEnabled } from '../streams/client.js';

export const runConfigSchema = z.object({
  scenarioIds: z.array(z.string()).min(1).max(19).refine((ids) => new Set(ids).size === ids.length, 'Select each scenario once.'),
  network: z.enum(['arc-testnet', 'fake']),
  agent: z.enum(AGENT_KINDS),
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
}
export class DashboardError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function missingConfiguration(config: RunConfig, env: NodeJS.ProcessEnv): string[] {
  const keys: string[] = [];
  if (config.agent !== 'naive') keys.push('XAI_API_KEY', 'XAI_MODEL');
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

  constructor(private readonly options: {
    env?: NodeJS.ProcessEnv;
    outDir?: string;
    defaults?: Partial<RunConfig>;
    execute?: typeof runOnce;
  } = {}) {
    this.env = options.env ?? process.env;
    this.outDir = options.outDir ?? DEFAULT_REPORT_DIR;
  }

  config() {
    const defaults: RunConfig = { scenarioIds: FOCUSED_SCENARIOS, network: 'arc-testnet', agent: 'grok', ...this.options.defaults };
    // Only readiness booleans/names cross the boundary, never environment values.
    return { defaults, scenarios: scenarioCatalog(), agents: AGENT_KINDS, model: this.env.XAI_MODEL ?? null, streamsEnabled: streamsEnabled(this.env),
      configured: Object.fromEntries(['XAI_API_KEY', 'XAI_MODEL', 'CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'WALLET_ID_HOT', 'WALLET_ID_VAULT', 'WALLET_ID_MERCHANT', 'ATTACKER_PRIVATE_KEY', 'FAKE_USDC_ADDRESS'].map((key) => [key, Boolean(this.env[key])])) };
  }

  snapshot() { return { run: this.run ?? null }; }
  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(input: unknown): LiveRun {
    if (this.run && ['running', 'stopping'].includes(this.run.status)) throw new DashboardError('A comparison is already running.', 409);
    const parsed = runConfigSchema.safeParse(input);
    if (!parsed.success) throw new DashboardError(parsed.error.issues.map((i) => i.message).join(' '));
    const config = parsed.data;
    if (config.scenarioIds.some((id) => !ALL_SCENARIOS.some((s) => s.id === id))) throw new DashboardError('Unknown scenario selected.');
    const missing = missingConfiguration(config, this.env);
    if (missing.length) throw new DashboardError(`Configure ${missing.join(', ')} in .env, then restart the dashboard.`, 422);
    const scenarios = executionOrder(ALL_SCENARIOS.filter((s) => config.scenarioIds.includes(s.id)));
    this.stopping = false;
    this.run = { id: randomUUID(), status: 'running', config, queue: scenarios.map((s) => s.id), events: [], sequence: 0, reports: {} };
    this.task = this.execute(this.run);
    return this.run;
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
    const secrets = Object.entries(this.env).filter(([key, value]) => /API_KEY|SECRET|PRIVATE_KEY/.test(key) && value).map(([, value]) => value!);
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
      const agent = createAgent(run.config.agent, this.env);
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
  }
}
