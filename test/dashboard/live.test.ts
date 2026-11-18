import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ALL_SCENARIOS } from '../../src/redteam/scenarios/index.js';

const ALL_SCENARIO_COUNT = ALL_SCENARIOS.length;
import { startDashboard, type DashboardServer } from '../../src/dashboard/server.js';
import { RunManager, type LiveEvent } from '../../src/dashboard/manager.js';
import { runOnce } from '../../src/redteam/service.js';
import { NaiveAgent } from '../../src/redteam/naive-agent.js';
import { parseReport, serializeReport } from '../../src/report/store.js';
import { renderHtml } from '../../src/report/html.js';
import { renderMarkdown } from '../../src/report/render.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: LiveEvent[] = [];
  return {
    events,
    cancel: () => reader.cancel(),
    async until(predicate: (event: LiveEvent) => boolean): Promise<LiveEvent> {
      for (;;) {
        const index = buffer.indexOf('\n\n');
        if (index >= 0) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6)) as LiveEvent;
          events.push(event);
          if (predicate(event)) return event;
        } else {
          const chunk = await reader.read();
          if (chunk.done) throw new Error('Event stream closed before the expected event.');
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      }
    },
  };
}

describe('live dashboard', () => {
  let server: DashboardServer | undefined;
  const gates: ReturnType<typeof deferred>[] = [];
  afterEach(async () => { for (const gate of gates) gate.resolve(); await server?.close(); server = undefined; });
  const config = { network: 'fake', agent: 'naive', scenarioIds: ['swap-payto', 'honest-1', 'counterfeit-usdc', 'prompt-injection'] };
  async function start(options: ConstructorParameters<typeof RunManager>[0] = {}) {
    const outDir = mkdtempSync(join(tmpdir(), 'tripwire-dashboard-'));
    const manager = new RunManager({ env: {}, outDir, ...options });
    server = await startDashboard({ manager });
    const url = new URL(server.url);
    const endpoint = (path: string) => `${url.origin}${path}${path.includes('?') ? '&' : '?'}${url.search.slice(1)}`;
    const request = (path: string, body?: unknown) => fetch(endpoint(path), body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { manager, request, endpoint, outDir };
  }

  it('starts idle with Arc/Grok defaults and validates configuration without starting payments', async () => {
    const { request, manager } = await start();
    const defaults = await (await request('/api/config')).json();
    expect(defaults.defaults).toMatchObject({ network: 'arc-testnet', agent: 'grok' });
    expect(defaults.scenarios).toHaveLength(ALL_SCENARIO_COUNT);
    expect(manager.run).toBeUndefined();
    const missing = await request('/api/runs', defaults.defaults);
    expect(missing.status).toBe(422);
    expect(await missing.text()).toContain('XAI_API_KEY');
    expect(manager.run).toBeUndefined();
    expect((await request('/api/runs', { ...config, scenarioIds: ['unknown'] })).status).toBe(400);
    expect((await request('/api/runs', { ...config, agent: 'unknown' })).status).toBe(400);
    expect((await request('/api/runs', { ...config, scenarioIds: [] })).status).toBe(400);
    expect((await request('/api/runs', { ...config, scenarioIds: ['swap-payto', 'swap-payto'] })).status).toBe(400);
  });

  it('streams pending operations, reconnects after a cursor, and preserves sequential measured comparisons', async () => {
    const gate = deferred(); gates.push(gate);
    let once = true;
    const { manager, request, endpoint, outDir } = await start({ execute: (opts) => runOnce({ ...opts, agent: {
      name: 'observed-naive',
      run: (task, tools, sink) => new NaiveAgent().run(task, { ...tools, getQuote: async (...args) => {
        if (once) { once = false; await gate.promise; }
        return tools.getQuote(...args);
      } }, sink),
    } }) });
    expect((await request('/api/runs', config)).status).toBe(202);
    const id = manager.run!.id;
    const first = await eventReader(await fetch(endpoint(`/api/runs/${id}/events`)));
    const pending = await first.until((e) => e.type === 'tool.started');
    expect(manager.run!.status).toBe('running');
    expect(manager.run!.events.some((e) => e.type === 'scenario.completed')).toBe(false);
    expect((await request('/api/runs', config)).status).toBe(409);
    await first.cancel();
    expect(manager.run!.status).toBe('running');
    const second = await eventReader(await fetch(endpoint(`/api/runs/${id}/events`), { headers: { 'Last-Event-ID': String(pending.sequence) } }));
    gate.resolve();
    await second.until((e) => e.type === 'run.completed');
    await second.cancel();
    expect(second.events.every((e) => e.sequence > pending.sequence)).toBe(true);
    expect(new Set(second.events.map((e) => e.sequence)).size).toBe(second.events.length);
    expect(manager.run!.queue).toEqual(['honest-1', 'counterfeit-usdc', 'swap-payto', 'prompt-injection']);
    expect(manager.run!.status).toBe('completed');
    const events = manager.run!.events;
    const firstBaseline = events.findIndex((e) => e.type === 'phase.started' && e.phase === 'unguarded');
    const guardedDone = events.findIndex((e) => e.type === 'phase.completed' && e.phase === 'guarded');
    expect(firstBaseline).toBeGreaterThan(guardedDone);
    const receipt = events.findIndex((e) => e.type === 'guard.decision' && (e.data as { side: string }).side === 'receive');
    const delivery = events.findIndex((e) => e.type === 'delivery');
    expect(receipt).toBeLessThan(delivery);
    const guarded = manager.run!.reports.guarded!;
    expect(guarded.report.overall).toBe(100);
    expect(manager.run!.reports.unguarded!.report.overall).toBe(20);
    const result = guarded.report.results.find((r) => r.id === 'swap-payto')!;
    expect(result.transcript!.filter((e) => e.kind === 'tool')).toHaveLength(3);
    expect(result).toMatchObject({ measurementStatus: 'complete', expectedChecks: ['intent-match'], stoppedBy: 'intent-match' });
    result.balanceCheck = { ownerOutflow: -1n, explainedOutflow: 0n, attackerGain: -2n, attackerRecorded: 0n };
    expect(parseReport(serializeReport(guarded)).report.results.find((r) => r.id === 'swap-payto')).toEqual(result);
    expect(readdirSync(outDir).filter((f) => f.endsWith('.json'))).toHaveLength(2);
    const reportResponse = await request(`/api/runs/${id}/report/comparison.html`);
    expect(reportResponse.headers.get('content-disposition')).toContain('attachment');
    expect(await reportResponse.text()).toContain('Without the guard');
    const saved = readdirSync(outDir).find((f) => f.endsWith('-guarded.json'))!;
    expect(parseReport(readFileSync(join(outDir, saved), 'utf8')).report.results[0]!.measurementStatus).toBe('complete');
  });

  it('stops after measuring and cleaning up the current scenario, withholding a full-run score', async () => {
    const gate = deferred(); gates.push(gate);
    let merchantUrl = '';
    const { manager, request } = await start({ execute: (opts) => runOnce({ ...opts, agent: {
      name: 'pause-before-quote',
      run: (task, tools, sink) => new NaiveAgent().run(task, { ...tools, getQuote: async (url, item) => {
        merchantUrl = url; await gate.promise; return tools.getQuote(url, item);
      } }, sink),
    } }) });
    await request('/api/runs', config);
    const id = manager.run!.id;
    const stream = await eventReader(await request(`/api/runs/${id}/events`));
    await stream.until((e) => e.type === 'tool.started');
    expect((await request(`/api/runs/${id}/stop`, {})).status).toBe(202);
    expect(manager.run!.status).toBe('stopping');
    gate.resolve();
    await stream.until((e) => e.type === 'run.completed'); await stream.cancel();
    expect(manager.run!.status).toBe('partial');
    const saved = manager.run!.reports.guarded!;
    expect(saved.partial).toBe(true);
    expect(saved.report.results).toHaveLength(1);
    expect(saved.report.results[0]!.measurementStatus).toBe('complete');
    expect(manager.run!.reports.unguarded).toBeUndefined();
    expect(renderHtml(saved)).toContain('score withheld');
    expect(renderMarkdown(saved)).toContain('Partial run — score withheld');
    await expect(fetch(merchantUrl + '/quote?item=report')).rejects.toThrow();
  });

  it('replays the complete full-suite journal without dropping large result frames', async () => {
    const { manager, request } = await start();
    const complete = new Promise<void>((resolve) => manager.subscribe((event) => { if (event.type === 'run.completed') resolve(); }));
    await request('/api/runs', { ...config, scenarioIds: manager.config().scenarios.map((s) => s.id) });
    await complete;
    expect(JSON.stringify(manager.run!.events).length).toBeGreaterThan(65_536);
    const stream = await eventReader(await request(`/api/runs/${manager.run!.id}/events`));
    await stream.until((event) => event.type === 'run.completed');
    await stream.cancel();
    expect(stream.events.filter((event) => event.type === 'scenario.completed')).toHaveLength(ALL_SCENARIO_COUNT * 2);
    expect(stream.events.map((event) => event.sequence)).toEqual(manager.run!.events.map((event) => event.sequence));
  }, 30_000);

  it('authenticates routes, rejects foreign hosts/origins, and redacts secrets from snapshots and events', async () => {
    const secret = 'sentinel-secret-api-key';
    const { request, endpoint, manager } = await start({ env: { XAI_API_KEY: secret }, execute: async (opts) => {
      opts.io.log(`provider diagnostic ${secret}`);
      throw new Error(`failed ${secret}`);
    } });
    const url = new URL(server!.url);
    expect((await fetch(url.origin + '/api/config')).status).toBe(403);
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const target = new URL(endpoint('/api/config'));
      const req = httpRequest({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.end();
    });
    expect(foreignHost).toBe(403);
    expect((await fetch(endpoint('/api/config'), { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(endpoint('/api/runs'), { method: 'GET' })).status).toBe(405);
    // The guard's rules: same auth as every /api route, no secrets, no addresses.
    expect((await fetch(url.origin + '/api/guard')).status).toBe(403);
    expect((await request('/api/guard?network=mainnet')).status).toBe(400);
    const guard = await (await request('/api/guard?network=arc-testnet')).text();
    expect(guard).not.toContain(secret);
    expect(guard).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect((JSON.parse(guard) as { rules: unknown[] }).rules).toHaveLength(10);
    const html = await request('/');
    expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const page = await html.text();
    expect(page).toContain('Your agent. Under attack.');
    expect(page).toMatch(/<body>\s*<div class="ledger-bg" aria-hidden="true">/);
    // Tripwires: one above the hero's bottom row and one in each section's top gap, all decorative.
    expect(page.match(/<span class="tripwire" aria-hidden="true">/g)).toHaveLength(6);
    // How the guard works: first section after the hero, linked from the header.
    expect(page).toMatch(/<nav class="site-nav"[^>]*><a href="#guard">Guard<\/a>/);
    expect(page).toMatch(/<\/section>\s*<main>\s*<div id="notice"[^>]*><\/div>\s*<section class="section guard-section" id="guard"/);
    expect(page).toContain('<a id="monitor-link" href="#streams-monitor">');
    expect(page).toContain('A live <span class="red-team">red team</span> for an AI agent');
    // Decorative chain: hidden from assistive tech, each block's prev is the previous hash.
    expect(page).toMatch(/<div class="hero-art" aria-hidden="true">/);
    expect(page).toContain('prev 0x0e99…72ff');
    expect(page).toContain('awaiting the guard');
    expect(page).toMatch(/<\/h1>\s*<p class="hero-tagline[^"]*">TripWire signs only what passes your rules\.<\/p>/);
    // An inline icon stops the browser requesting /favicon.ico without the token (a 403).
    expect(page).toMatch(/<link rel="icon" href="data:[^"]*">/);
    expect(html.headers.get('content-security-policy')).toContain('img-src \'self\' data:');
    await request('/api/runs', config);
    const stream = await eventReader(await request(`/api/runs/${manager.run!.id}/events`));
    await stream.until((e) => e.type === 'run.failed'); await stream.cancel();
    const snapshot = await (await request('/api/state')).text();
    expect(snapshot).not.toContain(secret);
    expect(snapshot).toContain('[redacted]');
    expect((await request(`/api/runs/${manager.run!.id}/report/../../.env`)).status).toBe(404);
  });
});
