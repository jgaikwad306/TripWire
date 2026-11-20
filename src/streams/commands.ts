import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createArcClient } from '../chain/arc.js';
import { createCircleClient, loadWallets } from '../wallet/circle.js';
import { StreamClient, streamClient } from './client.js';
import { batchSchema, configurationSchema, renderFilter, type StreamConfiguration, type WatchedWallets } from './model.js';
import { dataDirectory, startStreamServer, type StreamCredentials } from './server.js';

const API = 'https://api.quicknode.com/streams/rest/v1';
class QuickNodeApiError extends Error {
  constructor(message: string, readonly maxBatchSize?: number) { super(message); }
}
// The same installation boundary must survive a timed-out provider create request.
const preparedSchema = z.object({ externalId: z.string(), startBlock: z.number().int().nonnegative(), liveBoundary: z.number().int().nonnegative(), wallets: z.object({ hot: z.string(), vault: z.string(), merchant: z.string() }) });

/**
 * A provider error message that is safe to print: secrets and the destination are blanked
 * (the body may echo them), and anything that still looks like a credential is cut.
 */
export function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) if (secret) out = out.split(secret).join('[redacted]');
  out = out.replace(/https?:\/\/\S+/g, '[url]').replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

export async function provisionStream(opts: {
  client: StreamClient; key: string; webhookUrl: string; backfillBlocks: number; head: number; directory: string;
  fetchImpl?: typeof fetch;
}): Promise<StreamConfiguration> {
  const destination = new URL(opts.webhookUrl);
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.pathname !== '/webhooks/quicknode' || destination.search || destination.hash) throw new Error('--webhook-url must be an HTTPS URL ending in /webhooks/quicknode without credentials or query parameters');
  if (!Number.isSafeInteger(opts.backfillBlocks) || opts.backfillBlocks < 1 || opts.backfillBlocks > 1_000_000) throw new Error('--backfill-blocks must be between 1 and 1000000');
  const setup = await opts.client.request<{ wallets: WatchedWallets; credentials: StreamCredentials; configuration: StreamConfiguration | null }>('/setup');
  const preparedFile = join(opts.directory, 'setup.json');
  let prepared = existsSync(preparedFile) ? preparedSchema.parse(JSON.parse(readFileSync(preparedFile, 'utf8'))) : undefined;
  if (prepared && (prepared.externalId !== setup.credentials.externalId || JSON.stringify(prepared.wallets) !== JSON.stringify(setup.wallets))) throw new Error('Saved provisioning intent belongs to a different monitor');
  if (!prepared) {
    prepared = { externalId: setup.credentials.externalId, startBlock: Math.max(0, opts.head - opts.backfillBlocks + 1), liveBoundary: opts.head, wallets: setup.wallets };
    writeFileSync(`${preparedFile}.tmp`, JSON.stringify(prepared), { mode: 0o600, flush: true });
    renameSync(`${preparedFile}.tmp`, preparedFile);
    const directoryFile = openSync(opts.directory, 'r');
    try { fsyncSync(directoryFile); } finally { closeSync(directoryFile); }
  }
  const call = async (path: string, method: string, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await (opts.fetchImpl ?? fetch)(`${API}${path}`, {
      method, headers: { 'x-api-key': opts.key, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    // Provider bodies may echo destination credentials. Never include them in errors/logs.
    if (!res.ok) {
      const detail = await res.json().catch(() => null) as { message?: unknown } | null;
      const limit = typeof detail?.message === 'string' ? /Dataset batch size is greater than max batch size: \d+ > (\d+)/i.exec(detail.message) : null;
      const reason = typeof detail?.message === 'string' ? `: ${redact(detail.message, [setup.credentials.securityToken, destination.href, destination.host, opts.key])}` : '';
      throw new QuickNodeApiError(`QuickNode Streams API ${method} ${path} returned ${res.status}${reason}`, limit ? Number(limit[1]) : undefined);
    }
    const text = await res.text();
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  };
  const filter = Buffer.from(renderFilter(setup.wallets)).toString('base64');
  const tested = await call('/streams/test_filter', 'POST', { network: 'arc-testnet', dataset: 'block_with_receipts', filter_function: filter, block: String(prepared.liveBoundary) });
  batchSchema.parse(typeof tested.result === 'string' ? JSON.parse(tested.result) : tested.result);
  const attributes = { url: destination.href, compression: 'none', max_retry: 10, retry_interval_sec: 5, post_timeout_sec: 15, security_token: setup.credentials.securityToken };
  let batchSize = 5;
  const configureProvider = async (path: string, method: string, body: Record<string, unknown>) => {
    try { return await call(path, method, { ...body, dataset_batch_size: batchSize }); }
    catch (err) {
      // Subsecond tip streams may use the account's lower maximum (e.g. a trial's 1).
      if (!(err instanceof QuickNodeApiError) || !err.maxBatchSize || err.maxBatchSize >= batchSize) throw err;
      batchSize = err.maxBatchSize;
      return call(path, method, { ...body, dataset_batch_size: batchSize });
    }
  };
  let config = setup.configuration;
  if (!config) {
    const result = await configureProvider('/streams', 'POST', {
      name: 'TripWire USDC wallet safety', external_id: prepared.externalId, network: 'arc-testnet', dataset: 'block_with_receipts',
      region: 'usa_east', start_range: prepared.startBlock, dataset_batch_size: 5, elastic_batch_enabled: true,
      destination: 'webhook', destination_attributes: attributes, filter_function: filter,
      status: 'paused', fix_block_reorgs: 0, keep_distance_from_tip: 0,
    });
    const stream = (result.data && typeof result.data === 'object' ? result.data : result) as Record<string, unknown>;
    const id = stream.id;
    if (typeof id !== 'string' || !id) throw new Error('QuickNode did not return a Stream ID; retry setup to recover the idempotent create');
    config = configurationSchema.parse({ streamId: id, startBlock: prepared.startBlock, liveBoundary: prepared.liveBoundary, wallets: setup.wallets });
    await opts.client.request('/configure', config);
  }
  await configureProvider(`/streams/${encodeURIComponent(config.streamId)}`, 'PATCH', { filter_function: filter, destination_attributes: attributes, elastic_batch_enabled: true });
  const current = await call(`/streams/${encodeURIComponent(config.streamId)}`, 'GET');
  // Activating an already active Stream returns 422 on the real provider API.
  if (current.status !== 'active') await call(`/streams/${encodeURIComponent(config.streamId)}/activate`, 'POST');
  return config;
}

export async function streamsCommand(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const { values } = parseArgs({ args: rest, options: {
    'webhook-url': { type: 'string' }, 'backfill-blocks': { type: 'string', default: '10000' },
    'webhook-port': { type: 'string', default: '4021' }, 'control-port': { type: 'string', default: '4022' },
    'alert-id': { type: 'string' }, reason: { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (!command || values.help || command === '--help') {
    console.log('Usage: npm run cli streams <serve|setup|status|unfreeze>\n  setup --webhook-url https://HOST/webhooks/quicknode [--backfill-blocks 10000]\n  serve [--webhook-port 4021] [--control-port 4022]\n  unfreeze --alert-id HASH:LOG_INDEX --reason "Reviewed the transfer"'); return;
  }
  if (command === 'serve') {
    const port = (text: string) => {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Ports must be integers from 1 to 65535');
      return n;
    };
    const wallets = await loadWallets(createCircleClient());
    const server = await startStreamServer({ directory: dataDirectory(), wallets: { hot: wallets.hot.address, vault: wallets.vault.address, merchant: wallets.merchant.address }, webhookPort: port(values['webhook-port']), controlPort: port(values['control-port']) });
    console.log(`QuickNode Streams monitor\nWebhook: ${server.webhookUrl}\nLocal control: ${server.controlUrl}\nExpose port ${values['webhook-port']} through an HTTPS tunnel, then run streams setup. Keep both processes running.`);
    const shutdown = () => { void server.close().then(() => { process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); }); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); return;
  }
  const client = streamClient();
  if (command === 'status') { console.log(JSON.stringify(await client.status(), null, 2)); return; }
  if (command === 'unfreeze') {
    if (!values['alert-id'] || !values.reason?.trim()) throw new Error('Supply --alert-id and --reason');
    await client.request('/unfreeze', { id: values['alert-id'], reason: values.reason });
    console.log(JSON.stringify(await client.status(), null, 2)); return;
  }
  if (command !== 'setup') throw new Error(`Unknown streams command ${command}`);
  const key = process.env.QUICKNODE_API_KEY;
  if (!key) throw new Error('Set QUICKNODE_API_KEY in .env to a Streams-enabled QuickNode API key');
  if (!values['webhook-url']) throw new Error('Supply --webhook-url https://HOST/webhooks/quicknode');
  const config = await provisionStream({ client, key, webhookUrl: values['webhook-url'], backfillBlocks: Number(values['backfill-blocks']), head: Number(await createArcClient().getBlockNumber({ cacheTime: 0 })), directory: dataDirectory() });
  console.log(`Stream ${config.streamId} activated: backfill from block ${config.startBlock}, live monitoring after ${config.liveBoundary}.\nUse streams status to verify contiguous delivery before enabling QUICKNODE_STREAMS_ENABLED=true.`);
}
