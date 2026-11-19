import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { renderHtml } from '../report/html.js';
import { renderMarkdown } from '../report/render.js';
import { serializeReport } from '../report/store.js';
import { RunManager, DashboardError, type LiveEvent, type RunConfig } from './manager.js';
import { latestJournal, loadJournal, type RunJournal } from './journal.js';
import { renderDashboard } from './page.js';
import { guardRules } from './guard-rules.js';
import { MarketBoardSource } from './markets.js';
import { MARKET_FOCUSED_SCENARIOS } from './catalog.js';
import { MARKET_SUITE } from '../redteam/scenarios/index.js';
import { streamClient, streamsEnabled } from '../streams/client.js';

export interface DashboardServer {
  url: string;
  manager: RunManager;
  close(): Promise<void>;
}

export async function startDashboard(options: {
  port?: number; outDir?: string; env?: NodeJS.ProcessEnv; defaults?: Partial<RunConfig>; manager?: RunManager;
  replay?: { journal: RunJournal; speed?: number };
  /** The Prediction markets tab's odds board. Defaults to live Gemini public data (the snapshot in replay). */
  markets?: MarketBoardSource;
} = {}): Promise<DashboardServer> {
  const manager = options.manager ?? new RunManager(options);
  const markets = options.markets ?? new MarketBoardSource({
    env: manager.env,
    live: !options.replay,
    suite: MARKET_SUITE.map((s) => s.id),
    focused: MARKET_FOCUSED_SCENARIOS,
  });
  const token = randomBytes(24).toString('base64url');
  const streams = new Set<ServerResponse>();
  let allowedHosts: string[] = [];
  let closing = false;
  const secrets = Object.entries(manager.env).filter(([key, value]) => /API_KEY|SECRET|PRIVATE_KEY/.test(key) && value).map(([, value]) => value!);
  const redact = (text: string) => secrets.reduce((s, value) => s.split(value).join('[redacted]'), text);
  const json = (data: unknown): string => redact(JSON.stringify(data, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
  const headers = {
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
  const send = (res: ServerResponse, status: number, body: string, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...headers, 'content-type': type, ...extra });
    res.end(body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!allowedHosts.includes(req.headers.host ?? '')) throw new DashboardError('Forbidden', 403);
    const url = new URL(req.url ?? '/', 'http://dashboard');
    const supplied = Buffer.from(url.searchParams.get('token') ?? '');
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new DashboardError('Forbidden', 403);
    if (req.headers.origin && !allowedHosts.some((host) => req.headers.origin === `http://${host}`)) throw new DashboardError('Forbidden', 403);
    const method = req.method;
    const path = url.pathname;
    const isPost = path === '/api/runs' || /^\/api\/runs\/[^/]+\/stop$/.test(path);
    if (method !== (isPost ? 'POST' : 'GET')) return send(res, 405, json({ error: 'Method not allowed' }), undefined, { allow: isPost ? 'POST' : 'GET' });
    if (path === '/') return send(res, 200, renderDashboard(token), 'text/html; charset=utf-8');
    if (path === '/assets/app.js' || path === '/assets/dashboard.css') {
      const file = path.endsWith('.js') ? 'client.js' : 'dashboard.css';
      return send(res, 200, readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
    }
    if (path === '/api/config') return send(res, 200, json(manager.config()));
    if (path === '/api/state') return send(res, 200, json(manager.snapshot()));
    if (path === '/api/guard') {
      // The guard's paid-API rules and the values a run on this network enforces. Summaries only.
      const network = url.searchParams.get('network') ?? manager.config().defaults.network;
      if (network !== 'fake' && network !== 'arc-testnet') throw new DashboardError('Choose network fake or arc-testnet.');
      return send(res, 200, json(guardRules(network)));
    }
    if (path === '/api/markets') {
      // Public Gemini market data, read server side; the browser never calls Gemini.
      try { return send(res, 200, json(await markets.board())); }
      catch (err) { throw new DashboardError(`Market data unavailable: ${err instanceof Error ? err.message : String(err)}`, 503); }
    }
    if (path === '/api/streams') {
      if (!streamsEnabled(manager.env)) return send(res, 200, json({ enabled: false }));
      try { return send(res, 200, json(await streamClient(manager.env).status())); }
      catch { return send(res, 200, json({ enabled: true, ready: false, reason: 'Streams monitor unavailable; guarded spending blocked.' })); }
    }
    if (path === '/api/runs') {
      if (closing) throw new DashboardError('The dashboard is shutting down.', 503);
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 16_384) throw new DashboardError('Request too large.', 413);
      }
      let input: unknown;
      try { input = JSON.parse(body); } catch { throw new DashboardError('Send valid JSON.'); }
      manager.start(input);
      return send(res, 202, json(manager.snapshot()));
    }
    const match = /^\/api\/runs\/([^/]+)\/(events|stop|report(?:\/([^/]+))?)$/.exec(path);
    if (!match || manager.run?.id !== match[1]) throw new DashboardError('Not found', 404);
    const run = manager.run!;
    if (match[2] === 'stop') {
      manager.stop(run.id);
      return send(res, 202, json({ status: run.status }));
    }
    if (match[2] === 'events') {
      const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0 || after > run.sequence) throw new DashboardError('Invalid event cursor.');
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      streams.add(res);
      const writeFrame = (frame: string) => {
        if (res.destroyed || res.writableEnded) return;
        // A false write result means accepted-but-buffered, including a single large
        // scenario result. Do not disconnect clients merely for crossing highWaterMark.
        res.write(frame);
        if (res.writableLength > Math.max(2 * 1024 * 1024, Buffer.byteLength(frame) * 2)) res.destroy();
      };
      const write = (event: LiveEvent) => {
        if (event.runId !== run.id) { writeFrame('event: reset\ndata: {}\n\n'); res.end(); return; }
        writeFrame(`id: ${event.sequence}\ndata: ${json(event)}\n\n`);
      };
      const unsubscribe = manager.subscribe(write);
      for (const event of run.events) if (event.sequence > after) write(event);
      const heartbeat = setInterval(() => writeFrame(': heartbeat\n\n'), 15_000);
      res.on('error', () => res.destroy());
      res.on('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(res); });
      return;
    }
    const artifact = match[3];
    if (!artifact) return send(res, 200, json({ files: reportFiles(run) }));
    let body: string;
    let type: string;
    if (artifact === 'comparison.html' && run.status === 'completed') {
      body = renderHtml(run.reports.guarded!, run.reports.unguarded!); type = 'text/html; charset=utf-8';
    } else {
      const file = /^(guarded|unguarded)\.(json|md|html)$/.exec(artifact);
      const saved = file ? run.reports[file[1] as 'guarded' | 'unguarded'] : undefined;
      if (!file || !saved) throw new DashboardError('Report not available yet.', 404);
      const ext = file[2];
      body = ext === 'json' ? serializeReport(saved) : ext === 'md' ? renderMarkdown(saved) : renderHtml(saved);
      type = ext === 'json' ? 'application/json; charset=utf-8' : ext === 'md' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8';
    }
    return send(res, 200, redact(body), type, { 'content-disposition': `attachment; filename="tripwire-${run.id}-${artifact}"` });
  };
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (res.headersSent) { res.end(); return; }
      send(res, err instanceof DashboardError ? err.status : 500, json({ error: err instanceof DashboardError ? err.message : 'The dashboard could not complete this request.' }));
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const { port } = server.address() as AddressInfo;
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`, manager,
    close: () => closed ??= (async () => {
      markets.stop();
      closing = true;
      await manager.close();
      for (const stream of streams) stream.end();
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => server.closeAllConnections(), 1000);
        deadline.unref();
        server.close((err) => { clearTimeout(deadline); if (err) reject(err); else resolve(); });
        server.closeIdleConnections();
      });
    })(),
  };
}

function reportFiles(run: NonNullable<RunManager['run']>): string[] {
  return [...Object.keys(run.reports).flatMap((phase) => ['json', 'md', 'html'].map((ext) => `${phase}.${ext}`)), ...(run.status === 'completed' ? ['comparison.html'] : [])];
}

export async function dashboardCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    port: { type: 'string', default: '0' }, out: { type: 'string', default: 'reports' },
    fake: { type: 'boolean', default: false }, agent: { type: 'string' }, help: { type: 'boolean', default: false },
    replay: { type: 'boolean', default: false }, speed: { type: 'string', default: '1' },
  } });
  if (values.help) { console.log('Usage: npm run cli dashboard -- [--port 3000] [--out reports] [--fake] [--agent naive|grok|grok-careful]\n       npm run demo:replay -- [recording.journal.json] [--speed 2]\nDefaults: Arc Testnet + Grok. Runs start from the browser. Every finished run is recorded under <out>/runs/.'); return; }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535.');
  if (values.agent && !['naive', 'grok', 'grok-careful'].includes(values.agent)) throw new Error('Choose --agent naive, grok, or grok-careful.');
  let replay: { journal: RunJournal; speed: number } | undefined;
  if (values.replay) {
    const path = positionals[0] ?? latestJournal(values.out);
    if (!path) throw new Error(`No recording found. Run a comparison in the dashboard first (recordings go to ${values.out}/runs/), or pass a .journal.json file.`);
    const speed = Number(values.speed);
    if (!(speed > 0)) throw new Error('--speed must be a positive number.');
    replay = { journal: loadJournal(path), speed };
    console.log(`Replaying ${path} (recorded ${replay.journal.recordedAt}). Offline: nothing is executed.`);
  }
  const dashboard = await startDashboard({ port, outDir: values.out, ...(replay ? { replay } : {}), defaults: {
    network: values.fake ? 'fake' : 'arc-testnet', agent: (values.agent ?? 'grok') as RunConfig['agent'],
  } });
  console.log(`Tripwire live attack lab${replay ? ' (replay)' : ''}\n${dashboard.url}\n${replay ? 'Click Run comparison to play the recording.' : 'Runs begin in the browser. Ctrl+C finishes the current scenario before shutting down.'}`);
  const shutdown = () => { void dashboard.close().then(() => { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); }); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
