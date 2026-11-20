import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { latestJournal } from '../dashboard/journal.js';
import { DEFAULT_REPORT_DIR } from '../report/store.js';
import { streamClient } from '../streams/client.js';
import { dataDirectory } from '../streams/server.js';
import {
  cloudflaredCheck,
  envChecks,
  gatewayCheck,
  monitorCheck,
  nodeCheck,
  renderChecks,
  replayCheck,
  streamProgress,
  tunnelUrlIn,
  type CheckResult,
} from './checks.js';

const USAGE = `Usage: npm run cli demo <check|live|zip>

  check [--offline]            preflight for the live demo: tools, .env, monitor, recordings and
                               (unless --offline) the hot wallet's Gateway balance. Read-only.
  live [options]               everything the live demo needs, in one terminal: the Streams monitor,
                               a cloudflared tunnel, the Stream pointed at it, a wait until it is
                               ready, then the dashboard. Ctrl+C stops it all.
      --agent <kind>           naive | grok | grok-careful (default grok)
      --port <n>               dashboard port (default: any free one)
      --backfill-blocks <n>    blocks the new Stream backfills (default 1000)
      --wait-minutes <n>       how long to wait for the Stream to be ready (default 20)
      --no-dashboard           stop after the Stream is ready
  zip [--out <file>]           zip the repo for AirDrop without node_modules, .data, .claude or .env
                               (default ~/TripWire.zip)

The step-by-step version of all this is docs/pranavHandoff.md.`;

const WEBHOOK_PORT = 4021;

export async function demoCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (action === 'check') return demoCheck(rest);
  if (action === 'live') return demoLive(rest);
  if (action === 'zip') return demoZip(rest);
  console.log(USAGE);
}

// ── check ──

const versionOf = (cmd: string, args: string[]): string | undefined => {
  const out = spawnSync(cmd, args, { encoding: 'utf8' });
  if (out.error || out.status !== 0) return undefined;
  return `${out.stdout}${out.stderr}`.trim().split('\n')[0];
};

function lockPid(directory: string): { pid: number | undefined; alive: boolean } {
  const lock = join(directory, 'writer.pid');
  if (!existsSync(lock)) return { pid: undefined, alive: false };
  const pid = Number(readFileSync(lock, 'utf8'));
  if (!Number.isInteger(pid) || pid < 1) return { pid: undefined, alive: false };
  try {
    process.kill(pid, 0);
    return { pid, alive: true };
  } catch {
    return { pid, alive: false };
  }
}

async function hotGatewayBalance(): Promise<{ available?: bigint; error?: string }> {
  try {
    const { createLiveWallet } = await import('../wallet/index.js');
    const { HttpGatewayReader } = await import('../x402/gateway.js');
    const { wallet } = await createLiveWallet();
    const detail = await new HttpGatewayReader(process.env.GATEWAY_API_URL || undefined).balanceDetail(wallet.addressOf('hot'));
    return { available: detail.available };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function preflight(opts: { offline: boolean; liveTools: boolean }): Promise<CheckResult[]> {
  const envFile = resolve('.env');
  const results: CheckResult[] = [nodeCheck(process.version)];
  if (opts.liveTools) results.push(cloudflaredCheck(versionOf('cloudflared', ['--version'])));
  results.push(...envChecks(process.env, existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined));
  const lock = lockPid(dataDirectory());
  results.push(monitorCheck(lock.pid, lock.alive));
  results.push(replayCheck(latestJournal(DEFAULT_REPORT_DIR)));
  if (!opts.offline) {
    const balance = await hotGatewayBalance();
    results.push(gatewayCheck(balance.available, balance.error));
  }
  return results;
}

async function demoCheck(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { offline: { type: 'boolean', default: false } } });
  console.log('TripWire demo preflight\n');
  const results = await preflight({ offline: values.offline, liveTools: true });
  for (const line of renderChecks(results)) console.log(line);
  if (results.some((r) => r.status === 'fail')) process.exitCode = 1;
}

// ── live ──

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const tsx = () => join(process.cwd(), 'node_modules', '.bin', 'tsx');

/** Logs a child's output to a file, and optionally to the terminal with a prefix. */
function capture(child: ChildProcess, logFile: string, echo?: string, onLine?: (line: string) => void): void {
  const file = createWriteStream(logFile, { flags: 'a' });
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (line) => {
      file.write(`${line}\n`);
      if (echo !== undefined) console.log(`${echo}${line}`);
      onLine?.(line);
    });
  }
  child.once('exit', () => file.end());
}

async function monitorStatus() {
  try {
    return await streamClient().status();
  } catch {
    return undefined;
  }
}

async function demoLive(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      agent: { type: 'string', default: 'grok' },
      port: { type: 'string' },
      'backfill-blocks': { type: 'string', default: '1000' },
      'wait-minutes': { type: 'string', default: '20' },
      'no-dashboard': { type: 'boolean', default: false },
    },
  });
  if (!['naive', 'grok', 'grok-careful'].includes(values.agent)) throw new Error('Choose --agent naive, grok or grok-careful.');
  const backfill = Number(values['backfill-blocks']);
  const waitMs = Number(values['wait-minutes']) * 60_000;
  if (!(waitMs > 0)) throw new Error('--wait-minutes must be a positive number.');

  console.log('TripWire live demo\n\n1. Preflight');
  const checks = await preflight({ offline: false, liveTools: true });
  for (const line of renderChecks(checks)) console.log(line);
  if (checks.some((r) => r.status === 'fail')) throw new Error('\nFix the problems above first (npm run demo:check re-runs these checks).');

  const directory = dataDirectory();
  mkdirSync(directory, { recursive: true });
  const logs = join(directory, 'demo-logs');
  mkdirSync(logs, { recursive: true });
  const children: { name: string; child: ChildProcess; critical: boolean }[] = [];
  let stopping = false;
  const stopAll = (why: 'signal' | 'error' = 'signal') => {
    if (stopping) return;
    stopping = true;
    console.log(why === 'error' ? '\nStopping the monitor and tunnel because of the error below.' : '\nStopping: the dashboard finishes its current scenario first…');
    // Ctrl+C already reached every child in this terminal; this covers the other ways out.
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGINT');
    const force = setTimeout(() => {
      for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL');
    }, 20_000);
    force.unref();
  };
  const track = (name: string, child: ChildProcess, critical: boolean) => {
    children.push({ name, child, critical });
    child.once('exit', (code, signal) => {
      if (stopping) return;
      if (critical) {
        console.error(`\n!! The ${name} stopped (${signal ?? `exit ${code}`}). Guarded spending is now blocked. Logs: ${logs}`);
        console.error('!! Press Ctrl+C, then run npm run demo:live again: it reuses this Stream and points it at the new tunnel.');
      }
    });
  };
  const onSignal = () => stopAll('signal');
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    // 2. Monitor: reuse one already serving this data directory, else start it.
    console.log('\n2. Streams monitor');
    if (await monitorStatus()) {
      console.log(`   already running for ${directory}; reusing it`);
    } else {
      const monitor = spawn(tsx(), ['src/cli.ts', 'streams', 'serve'], { stdio: ['ignore', 'pipe', 'pipe'] });
      capture(monitor, join(logs, 'monitor.log'));
      track('Streams monitor', monitor, true);
      const deadline = Date.now() + 60_000;
      while (!(await monitorStatus())) {
        if (monitor.exitCode !== null) throw new Error(`The monitor exited (code ${monitor.exitCode}); see ${join(logs, 'monitor.log')}`);
        if (Date.now() > deadline) throw new Error(`The monitor did not start within a minute; see ${join(logs, 'monitor.log')}`);
        await sleep(1000);
      }
      console.log(`   running (log: ${join(logs, 'monitor.log')})`);
    }

    // 3. Tunnel: a fresh quick tunnel; its URL changes every time.
    console.log('\n3. cloudflared tunnel');
    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${WEBHOOK_PORT}`, '--no-autoupdate', '--protocol', 'http2'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let url: string | undefined;
    let connected = false;
    capture(tunnel, join(logs, 'tunnel.log'), undefined, (line) => {
      url ??= tunnelUrlIn(line);
      if (/Registered tunnel connection/.test(line)) connected = true;
    });
    track('cloudflared tunnel', tunnel, true);
    const tunnelDeadline = Date.now() + 90_000;
    while (!url || !connected) {
      if (tunnel.exitCode !== null) throw new Error(`cloudflared exited (code ${tunnel.exitCode}); see ${join(logs, 'tunnel.log')}`);
      if (Date.now() > tunnelDeadline) throw new Error(`No tunnel within 90s; see ${join(logs, 'tunnel.log')}`);
      await sleep(500);
    }
    const webhookUrl = `${url}/webhooks/quicknode`;
    console.log(`   ${webhookUrl}`);
    await waitReachable(webhookUrl);

    // 4. Point the Stream at the tunnel: creates it on first run, re-targets it after a restart.
    console.log(`\n4. QuickNode Stream (backfill ${backfill} blocks)`);
    const { provisionStream } = await import('../streams/commands.js');
    const { createArcClient } = await import('../chain/arc.js');
    const head = Number(await createArcClient().getBlockNumber({ cacheTime: 0 }));
    const config = await withRetries(() =>
      provisionStream({ client: streamClient(), key: process.env.QUICKNODE_API_KEY!.trim(), webhookUrl, backfillBlocks: backfill, head, directory }),
    );
    console.log(`   Stream ${config.streamId}, live after block ${config.liveBoundary}`);

    // 5. Wait until the monitor has the whole backfill and live data.
    console.log('\n5. Waiting for the Stream to be ready (usually 5–10 minutes)');
    const ready = await waitReady(waitMs);
    if (!ready) console.log('   Not ready yet. Starting anyway: guarded spending stays blocked until it is (npm run cli streams status).');

    if (values['no-dashboard']) {
      console.log('\nStream ready. Monitor and tunnel keep running; Ctrl+C stops them.');
    } else {
      // 6. Dashboard, in this terminal.
      console.log('\n6. Dashboard (open the 127.0.0.1 link below, then Run comparison)\n');
      const dash = spawn(tsx(), ['src/cli.ts', 'dashboard', '--agent', values.agent, ...(values.port ? ['--port', values.port] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
      capture(dash, join(logs, 'dashboard.log'), '   ');
      track('dashboard', dash, false);
    }

    // Terminal 4 of the runbook: keep the Mac awake while this runs.
    if (process.platform === 'darwin') {
      const awake = spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore' });
      track('caffeinate', awake, false);
      console.log('   (keeping the Mac awake; keep it plugged in)');
    }

    await Promise.all(children.filter((c) => c.child.exitCode === null).map((c) => new Promise((done) => c.child.once('exit', done))));
  } catch (err) {
    stopAll('error');
    await Promise.all(children.filter((c) => c.child.exitCode === null).map((c) => new Promise((done) => c.child.once('exit', done))));
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  console.log('\nStopped. Pause the Stream so it stops posting to a dead tunnel:');
  console.log('  dashboard.quicknode.com → Streams → "TripWire USDC wallet safety" → Pause');
}

/** The host's IPv4 address on public DNS (what QuickNode sees), not this Mac's resolver. */
export async function publicAddress(host: string): Promise<string | undefined> {
  for (const resolver of ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']) {
    try {
      const res = await fetch(`${resolver}?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
      const address = body.Answer?.find((a) => a.type === 1)?.data;
      if (address) return address;
    } catch {
      // Try the next resolver.
    }
  }
  return undefined;
}

/** One GET to `url`, connecting to `address` instead of resolving the host locally. */
export function probeVia(url: string, address: string): Promise<number | undefined> {
  return new Promise((done) => {
    const lookup = (_host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
      opts.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4);
    const req = httpsRequest(url, { method: 'GET', timeout: 5000, lookup: lookup as never }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(undefined));
    req.end();
  });
}

/**
 * QuickNode checks the webhook when a Stream is created or re-targeted, so wait until the
 * tunnel answers from the public internet. A new trycloudflare name can take a minute or
 * two to appear in DNS, and macOS keeps a "not found" answer for a while longer, so this
 * resolves through public DNS rather than this Mac's resolver.
 */
async function waitReachable(url: string): Promise<boolean> {
  const host = new URL(url).hostname;
  const deadline = Date.now() + 180_000;
  let said = false;
  while (Date.now() < deadline) {
    const address = await publicAddress(host);
    const status = address ? await probeVia(url, address) : undefined;
    // 502/503/530: Cloudflare has the name but cannot reach the monitor yet. Anything else is the monitor answering.
    if (status !== undefined && ![502, 503, 530].includes(status)) {
      console.log('   reachable from the internet');
      return true;
    }
    if (!said) {
      console.log('   waiting for the tunnel to appear in public DNS (can take a minute or two)…');
      said = true;
    }
    await sleep(3000);
  }
  console.log('   Still not reachable from the internet after 3 minutes; trying anyway.');
  return false;
}

/** QuickNode refuses a Stream whose webhook it cannot reach yet; give a just-made tunnel a few more tries. */
async function withRetries<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (tries >= 4 || !/returned 422/.test(message)) throw err;
      console.log(`   QuickNode refused it (${message}); retrying in 30s (${tries}/3)…`);
      await sleep(30_000);
    }
  }
}

async function waitReady(waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  let last = '';
  while (Date.now() < deadline) {
    const status = await monitorStatus();
    if (status) {
      const line = streamProgress(status);
      if (line !== last) console.log(`   ${line}`);
      last = line;
      if (status.ready) return true;
      const alert = status.alerts.find((a) => !a.acknowledged);
      if (status.frozen && alert) {
        console.log(`   Spending is frozen by an alert. Once reviewed: npm run cli streams unfreeze -- --alert-id '${alert.id}' --reason 'Reviewed testnet transfer'`);
      }
    }
    await sleep(10_000);
  }
  return false;
}

// ── zip ──

async function demoZip(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { out: { type: 'string', default: join(homedir(), 'TripWire.zip') } } });
  const root = process.cwd();
  const name = basename(root);
  const out = resolve(values.out);
  if (existsSync(out)) rmSync(out);
  const exclude = [`${name}/node_modules/*`, `${name}/.data/*`, `${name}/.claude/*`, `${name}/.env`, `${name}/reports/*`, '*/node_modules/*', '*.DS_Store'];
  const zip = spawnSync('zip', ['-r', '-q', out, name, '-x', ...exclude], { cwd: dirname(root), stdio: 'inherit' });
  if (zip.error || zip.status !== 0) throw new Error(`zip failed${zip.error ? `: ${zip.error.message}` : ` (exit ${zip.status})`}`);
  // Never hand over secrets: check what actually went in.
  const listing = spawnSync('zipinfo', ['-1', out], { encoding: 'utf8' });
  const entries = listing.stdout.split('\n');
  const leaked = entries.filter((e) => e === `${name}/.env` || /\/\.env$/.test(e) || /(^|\/)\.data\//.test(e));
  if (leaked.length) {
    rmSync(out);
    throw new Error(`Refusing to keep a zip with secrets in it (${leaked.join(', ')}); it was deleted.`);
  }
  console.log(`${out} (${entries.filter(Boolean).length} files). No node_modules, .data, .claude or .env.`);
  console.log('AirDrop it, unzip into the home folder, then: cd ~/TripWire && npm install');
  console.log('Send the .env separately, by AirDrop or USB only.');
}
