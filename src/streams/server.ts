import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { StreamMonitor } from './monitor.js';
import { AUTHORIZATION_USED, configurationSchema, hashSchema, topicAddress, walletsSchema, type WatchedWallets } from './model.js';
import { USDC_ADDRESS } from '../constants.js';

const credentialsSchema = z.object({ securityToken: z.string().min(32), controlToken: z.string().min(32), externalId: z.string().min(1) });
export type StreamCredentials = z.infer<typeof credentialsSchema>;
export const dataDirectory = (env: NodeJS.ProcessEnv = process.env) => resolve(env.QUICKNODE_STREAMS_DATA_DIR || '.data/streams');
export function loadCredentials(directory: string, create = false): StreamCredentials {
  const filename = join(directory, 'credentials.json');
  if (!existsSync(filename) && create) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(filename, JSON.stringify({ securityToken: randomBytes(32).toString('hex'), controlToken: randomBytes(32).toString('hex'), externalId: `tripwire-${randomUUID()}` }), { mode: 0o600, flag: 'wx', flush: true });
  }
  return credentialsSchema.parse(JSON.parse(readFileSync(filename, 'utf8')));
}
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
class HttpError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new HttpError('Payload too large', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
};
const listen = (server: Server, port: number) => new Promise<number>((resolvePort, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolvePort((server.address() as AddressInfo).port); });
});
const stop = (server: Server) => new Promise<void>((done, reject) => {
  const deadline = setTimeout(() => server.closeAllConnections(), 1000); deadline.unref();
  server.close(err => { clearTimeout(deadline); if (err) reject(err); else done(); }); server.closeIdleConnections();
});

export async function startStreamServer(opts: {
  directory: string; wallets: WatchedWallets; webhookPort?: number; controlPort?: number; now?: () => number;
}) {
  const wallets = walletsSchema.parse(opts.wallets);
  const credentials = loadCredentials(opts.directory, true);
  const lock = join(opts.directory, 'writer.pid');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid Streams writer lock');
    try { process.kill(pid, 0); throw new Error(`Streams monitor already running (pid ${pid})`); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err; }
    unlinkSync(lock);
  }
  const lockFile = openSync(lock, 'wx', 0o600);
  closeSync(lockFile); writeFileSync(lock, String(process.pid));
  let monitor: StreamMonitor;
  try { monitor = new StreamMonitor(opts.directory, opts.now); }
  catch (err) { unlinkSync(lock); throw err; }
  if (monitor.config && JSON.stringify(monitor.config.wallets) !== JSON.stringify(wallets)) {
    monitor.close(); unlinkSync(lock); throw new Error('Configured wallets changed; use a separate Streams data directory');
  }
  const now = opts.now ?? Date.now;
  const wrap = (handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    const server = createServer((req, res) => {
      void handler(req, res).catch(err => {
        if (res.headersSent) { res.end(); return; }
        const status = err instanceof HttpError ? err.status : err instanceof z.ZodError || err instanceof SyntaxError ? 400 : 503;
        send(res, status, { error: err instanceof HttpError ? err.message : status === 400 ? 'Invalid Streams payload' : 'Streams request failed; inspect monitor status or local logs' });
        if (status === 503) console.error('Streams:', err instanceof Error ? err.message : 'request failed');
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
    return server;
  };
  const webhook = wrap(async (req, res) => {
    if (req.url !== '/webhooks/quicknode') throw new HttpError('Not found', 404);
    if (req.method !== 'POST') throw new HttpError('POST required', 405);
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError('Configure uncompressed delivery', 415);
    const raw = await bodyOf(req);
    const nonce = req.headers['x-qn-nonce'], timestamp = req.headers['x-qn-timestamp'], signature = req.headers['x-qn-signature'];
    if (typeof nonce !== 'string' || nonce.length > 200 || typeof timestamp !== 'string' || !/^\d{10,13}$/.test(timestamp) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) throw new HttpError('Missing or invalid signature headers', 401);
    const timeMs = Number(timestamp) * (timestamp.length === 13 ? 1 : 1000);
    if (Math.abs(now() - timeMs) > 300_000) throw new HttpError('Expired webhook signature', 401);
    const computed = createHmac('sha256', credentials.securityToken).update(nonce + timestamp).update(raw).digest('hex');
    if (!same(computed, signature.toLowerCase())) throw new HttpError('Invalid signature', 401);
    monitor.ingest(JSON.parse(raw.toString('utf8')));
    send(res, 200, { accepted: true });
  });
  let controlHost = '';
  const control = wrap(async (req, res) => {
    if (![controlHost, controlHost.replace('127.0.0.1', 'localhost')].includes(req.headers.host ?? '') || req.headers.origin || !same(String(req.headers.authorization ?? ''), `Bearer ${credentials.controlToken}`)) throw new HttpError('Forbidden', 403);
    const url = new URL(req.url ?? '/', 'http://streams');
    const get = req.method === 'GET';
    if (get && url.pathname === '/status') { send(res, 200, monitor.status()); return; }
    if (get && url.pathname === '/setup') { send(res, 200, { wallets, credentials, configuration: monitor.config ?? null }); return; }
    if (get && url.pathname.startsWith('/receipt/')) {
      const hash = hashSchema.parse(url.pathname.slice('/receipt/'.length));
      send(res, 200, monitor.status().integrityError ? null : monitor.receipts.get(hash) ?? null); return;
    }
    if (get && url.pathname === '/authorization') {
      const from = url.searchParams.get('from'), nonce = url.searchParams.get('nonce');
      const receipt = monitor.status().integrityError ? undefined : [...monitor.receipts.values()].find(r => r.status === 'success' && r.logs.some(l => l.address === USDC_ADDRESS.toLowerCase() && l.topics[0] === AUTHORIZATION_USED && l.topics.length === 3 && topicAddress(l.topics[1]!) === from && l.topics[2] === nonce));
      send(res, 200, receipt?.transactionHash ?? null); return;
    }
    if (get && url.pathname === '/activity') {
      const address = url.searchParams.get('address');
      const watched = Object.values(wallets).includes(address as WatchedWallets['hot']);
      const status = monitor.status();
      send(res, 200, watched && status.ready ? [...monitor.receipts.values()].filter(r => r.status === 'success') : null); return;
    }
    if (req.method !== 'POST') throw new HttpError('Not found', 404);
    const input = JSON.parse((await bodyOf(req)).toString('utf8'));
    if (url.pathname === '/configure') {
      const config = configurationSchemaForWallets(input, wallets);
      monitor.configure(config);
    } else if (url.pathname === '/reserve') monitor.reserve(input);
    else if (url.pathname === '/submitted') {
      const data = z.object({ id: z.string(), txHash: hashSchema }).parse(input);
      monitor.submitted(data.id, data.txHash);
    } else if (url.pathname === '/unfreeze') {
      const data = z.object({ id: z.string(), reason: z.string().min(1).max(1000) }).parse(input);
      monitor.acknowledge(data.id, data.reason);
    } else throw new HttpError('Not found', 404);
    send(res, 200, { ok: true });
  });
  try {
    const webhookPort = await listen(webhook, opts.webhookPort ?? 4021);
    const controlPort = await listen(control, opts.controlPort ?? 4022);
    controlHost = `127.0.0.1:${controlPort}`;
    const announced = new Set<string>();
    const timer = setInterval(() => {
      try {
        for (const alert of monitor.status().alerts) if (!alert.acknowledged && !announced.has(alert.id)) {
          console.error(`STREAMS ALERT ${alert.id}: ${alert.reason}; ${alert.from} → ${alert.to}. Guarded spending frozen.`);
          announced.add(alert.id);
        }
      } catch { console.error('STREAMS ALERT: durable monitor state unavailable; guarded spending blocked.'); }
    }, 1000);
    timer.unref();
    let closed = false;
    return {
      webhookUrl: `http://127.0.0.1:${webhookPort}/webhooks/quicknode`, controlUrl: `http://${controlHost}`, monitor,
      close: async () => {
        if (closed) return; closed = true;
        clearInterval(timer);
        await Promise.all([stop(webhook), stop(control)]);
        monitor.close(); unlinkSync(lock);
      },
    };
  } catch (err) {
    if (webhook.listening) await stop(webhook);
    if (control.listening) await stop(control);
    monitor.close(); unlinkSync(lock); throw err;
  }
}

function configurationSchemaForWallets(input: unknown, wallets: WatchedWallets) {
  const config = configurationSchema.parse(input);
  if (JSON.stringify(config.wallets) !== JSON.stringify(wallets)) throw new HttpError('Wallets differ from this monitor', 400);
  return config;
}
