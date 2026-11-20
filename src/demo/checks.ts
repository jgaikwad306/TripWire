import { formatUsdc, parseUsdc } from '../constants.js';

/**
 * Demo-day preflight checks (docs/pranavHandoff.md). Pure: callers gather the facts (env,
 * the .env file's text, tool versions, balances) and these decide what is ready.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** The command or edit that fixes it. */
  fix?: string;
}

/** Keys a live demo cannot run without. */
export const REQUIRED_KEYS = ['CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET', 'WALLET_ID_VAULT', 'WALLET_ID_HOT', 'WALLET_ID_MERCHANT', 'ATTACKER_PRIVATE_KEY', 'XAI_API_KEY', 'XAI_MODEL'] as const;

/** The guard pays paid-API attacks from Gateway; the unguarded price-inflation attack alone spends 1 USDC. */
export const MIN_GATEWAY = parseUsdc('1.1');

/** The data directory the handoff gives each Mac, so it gets its own fresh Stream. */
export const DEMO_STREAMS_DIR = '.data/streams-live';

export function nodeCheck(version: string): CheckResult {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  return major >= 20
    ? { name: 'Node.js', status: 'ok', detail: version }
    : { name: 'Node.js', status: 'fail', detail: `${version}; v20 or newer is needed`, fix: 'brew install node' };
}

export function cloudflaredCheck(version: string | undefined): CheckResult {
  return version
    ? { name: 'cloudflared', status: 'ok', detail: version }
    : { name: 'cloudflared', status: 'fail', detail: 'not installed (the live demo tunnels QuickNode to the monitor through it)', fix: 'brew install cloudflared' };
}

/** Lines of the .env file that set `key`, in order. */
export const linesSetting = (envText: string, key: string): string[] =>
  envText.split(/\r?\n/).filter((line) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(line));

/** Checks on the .env file itself and the keys it sets. `envText` undefined: there is no .env. */
export function envChecks(env: NodeJS.ProcessEnv, envText: string | undefined): CheckResult[] {
  if (envText === undefined) {
    return [{ name: '.env', status: 'fail', detail: 'missing', fix: 'Get the team .env by AirDrop or USB (never Slack, email or Git) and put it in the repo root.' }];
  }
  const results: CheckResult[] = [{ name: '.env', status: 'ok', detail: 'present' }];

  const missing = REQUIRED_KEYS.filter((k) => !env[k]);
  results.push(
    missing.length
      ? { name: 'Circle, wallet and Grok keys', status: 'fail', detail: `missing ${missing.join(', ')}`, fix: 'Use the team .env; these come from it.' }
      : { name: 'Circle, wallet and Grok keys', status: 'ok', detail: `${REQUIRED_KEYS.length} keys set` },
  );

  results.push(
    env.QUICKNODE_API_KEY
      ? { name: 'QuickNode key', status: 'ok', detail: 'set' }
      : { name: 'QuickNode key', status: 'fail', detail: 'QUICKNODE_API_KEY is missing; the live monitor cannot create its Stream', fix: 'Use the team .env, which has it.' },
  );

  const enabled = env.QUICKNODE_STREAMS_ENABLED;
  results.push(
    enabled === 'true'
      ? { name: 'Streams monitoring', status: 'ok', detail: 'QUICKNODE_STREAMS_ENABLED=true: guarded spending waits for the monitor' }
      : { name: 'Streams monitoring', status: 'warn', detail: `QUICKNODE_STREAMS_ENABLED=${enabled ?? '(unset)'}: the guard will not consult the monitor`, fix: 'Set QUICKNODE_STREAMS_ENABLED=true in .env for the live demo.' },
  );

  const dirLines = linesSetting(envText, 'QUICKNODE_STREAMS_DATA_DIR');
  if (dirLines.length > 1) {
    results.push({ name: 'Streams data directory', status: 'fail', detail: `QUICKNODE_STREAMS_DATA_DIR is set ${dirLines.length} times in .env`, fix: `Keep exactly one line: QUICKNODE_STREAMS_DATA_DIR=${DEMO_STREAMS_DIR}` });
  } else if (env.QUICKNODE_STREAMS_DATA_DIR !== DEMO_STREAMS_DIR) {
    results.push({
      name: 'Streams data directory',
      status: 'warn',
      detail: `${env.QUICKNODE_STREAMS_DATA_DIR || '(default .data/streams)'}; a Mac new to the demo should use its own, fresh directory`,
      fix: `QUICKNODE_STREAMS_DATA_DIR=${DEMO_STREAMS_DIR} (one line) unless this Mac already runs the team's Stream`,
    });
  } else {
    results.push({ name: 'Streams data directory', status: 'ok', detail: DEMO_STREAMS_DIR });
  }

  results.push(
    env.FAKE_USDC_ADDRESS
      ? { name: 'Counterfeit token', status: 'ok', detail: 'FAKE_USDC_ADDRESS set' }
      : { name: 'Counterfeit token', status: 'warn', detail: 'FAKE_USDC_ADDRESS unset; the counterfeit-USDC scenario will fail', fix: 'npm run cli fake-usdc, then add the printed line to .env' },
  );
  return results;
}

/** The hot wallet's Gateway balance, or why it could not be read. */
export function gatewayCheck(available: bigint | undefined, error?: string): CheckResult {
  if (available === undefined) return { name: 'Gateway balance', status: 'warn', detail: `could not read it: ${error ?? 'unknown error'}`, fix: 'npm run setup-wallets' };
  return available >= MIN_GATEWAY
    ? { name: 'Gateway balance', status: 'ok', detail: `${formatUsdc(available)} USDC (needs ${formatUsdc(MIN_GATEWAY)})` }
    : { name: 'Gateway balance', status: 'fail', detail: `${formatUsdc(available)} USDC; the live comparison needs ${formatUsdc(MIN_GATEWAY)}`, fix: 'npm run refund, then npm run gateway:deposit -- 2' };
}

/** Another Streams monitor on this Mac, from its writer.pid lock. */
export function monitorCheck(lockPid: number | undefined, alive: boolean): CheckResult {
  if (lockPid === undefined || !alive) return { name: 'Streams monitor', status: 'ok', detail: 'none running on this Mac' };
  return { name: 'Streams monitor', status: 'warn', detail: `already running (pid ${lockPid}); demo:live will reuse it`, fix: 'Only one Mac should run the monitor for the demo wallets.' };
}

export function replayCheck(path: string | undefined): CheckResult {
  return path
    ? { name: 'Offline fallback', status: 'ok', detail: `npm run demo:replay plays ${path}` }
    : { name: 'Offline fallback', status: 'fail', detail: 'no recording to replay', fix: 'git restore recordings/ (the bundled recordings ship with the repo)' };
}

const ICON: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };

export function renderChecks(results: readonly CheckResult[]): string[] {
  const width = Math.max(...results.map((r) => r.name.length));
  const lines = results.map((r) => `  ${ICON[r.status]}  ${r.name.padEnd(width)}  ${r.detail}${r.fix && r.status !== 'ok' ? `\n        ${' '.repeat(width)}  → ${r.fix}` : ''}`);
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  lines.push('', fails ? `${fails} problem(s) to fix before a live demo${warns ? `, ${warns} warning(s)` : ''}.` : warns ? `Ready, with ${warns} warning(s).` : 'Ready for the live demo.');
  return lines;
}

/** The public URL cloudflared prints for a quick tunnel, if this line has it. */
export function tunnelUrlIn(line: string): string | undefined {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(line)?.[0];
}

/** One line of backfill progress from the monitor's status. */
export function streamProgress(status: { ready: boolean; reason?: string | undefined; startBlock?: number | undefined; liveBoundary?: number | undefined; coveredThrough: number }): string {
  if (status.ready) return 'ready';
  const { startBlock, liveBoundary, coveredThrough } = status;
  if (startBlock === undefined || liveBoundary === undefined) return status.reason ?? 'not ready';
  const total = Math.max(1, liveBoundary - startBlock + 1);
  const done = Math.min(total, Math.max(0, coveredThrough - startBlock + 1));
  return `${status.reason ?? 'not ready'}: block ${coveredThrough} of ${liveBoundary} (${Math.floor((done / total) * 100)}% of the backfill)`;
}

/**
 * Zip entries that must never be AirDropped: env files other than .env.example, Circle's
 * entity-secret recovery file, the monitor's data (control token, Stream credentials) and
 * Claude Code's local folder. `prefix` is the folder the zip wraps the repo in.
 */
export function secretEntries(entries: readonly string[], prefix: string): string[] {
  return entries.filter((entry) => {
    const path = entry.startsWith(`${prefix}/`) ? entry.slice(prefix.length + 1) : entry;
    const file = path.split('/').at(-1) ?? '';
    if (/^\.env(\..+)?$/.test(file) && file !== '.env.example') return true;
    if (/^recovery_file_.*\.dat$/.test(file)) return true;
    return /^(\.data|\.claude)(\/|$)/.test(path);
  });
}
