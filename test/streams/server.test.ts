import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCredentials, startStreamServer } from '../../src/streams/server.js';
import { StreamClient } from '../../src/streams/client.js';
import { provisionStream } from '../../src/streams/commands.js';
import { StreamActivityReader, StreamChainReader } from '../../src/streams/readers.js';
import { batch, block, configuration, hash, NOW, OTHER, transferReceipt, wallets } from './helpers.js';

const servers: Awaited<ReturnType<typeof startStreamServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => s.close())); });
async function setup(configure = true) {
  const dir = mkdtempSync(join(tmpdir(), 'tripwire-hook-'));
  const server = await startStreamServer({ directory: dir, wallets, webhookPort: 0, controlPort: 0, now: () => NOW }); servers.push(server);
  const credentials = loadCredentials(dir);
  const client = new StreamClient({ url: server.controlUrl, directory: dir });
  if (configure) server.monitor.configure(configuration);
  const deliver = async (payload: unknown, opts: { token?: string; timestamp?: string; signature?: string; raw?: string } = {}) => {
    const raw = opts.raw ?? JSON.stringify(payload), timestamp = opts.timestamp ?? String(NOW / 1000), nonce = 'test-nonce';
    const signature = opts.signature ?? createHmac('sha256', opts.token ?? credentials.securityToken).update(nonce + timestamp + raw).digest('hex');
    return fetch(server.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-qn-nonce': nonce, 'x-qn-timestamp': timestamp, 'x-qn-signature': signature }, body: raw });
  };
  return { server, client, dir, credentials, deliver };
}
describe('authenticated Stream destination and local control', () => {
  it('accepts actual signed bytes durably; repeated delivery creates one alert', async () => {
    const { server, deliver, dir } = await setup();
    expect((await deliver(batch(block(98), block(99), block(100)))).status).toBe(200);
    const payload = batch(block(101, [transferReceipt(101)]));
    expect((await deliver(payload)).status).toBe(200);
    expect(readFileSync(join(dir, 'journal.jsonl'), 'utf8')).toContain('USDC outflow');
    expect((await deliver(payload)).status).toBe(200);
    expect(server.monitor.status().alerts).toHaveLength(1);
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
  });
  it('rejects tampering, old signatures, malformed payloads and wrong networks without mutating state', async () => {
    const { server, deliver, dir } = await setup();
    const before = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
    expect((await deliver(batch(block(98)), { token: 'bad-key' })).status).toBe(401);
    expect((await deliver(batch(block(98)), { timestamp: String(NOW / 1000 - 301) })).status).toBe(401);
    expect((await deliver(batch(block(98)), { signature: 'broken' })).status).toBe(401);
    expect((await deliver(null, { raw: '{' })).status).toBe(400);
    expect((await deliver({ ...batch(block(98)), network: 'ethereum-mainnet' })).status).toBe(400);
    expect(server.monitor.blocks.size).toBe(0);
    expect(readFileSync(join(dir, 'journal.jsonl'), 'utf8')).toBe(before);
  });
  it('never exposes control routes on the tunnel, rejects origins, and requires a private token', async () => {
    const { server, client, dir } = await setup();
    expect((await fetch(new URL('/status', server.webhookUrl))).status).toBe(404);
    expect((await fetch(`${server.controlUrl}/status`)).status).toBe(403);
    const credentials = loadCredentials(dir);
    expect((await fetch(`${server.controlUrl}/status`, { headers: { authorization: `Bearer ${credentials.controlToken}`, origin: 'http://attacker.example' } })).status).toBe(403);
    expect((await client.status()).ready).toBe(false);
    await expect(new StreamClient({ url: 'http://example.com', token: 'private' }).status()).rejects.toThrow(/local HTTP/);
    await expect(startStreamServer({ directory: dir, wallets, webhookPort: 0, controlPort: 0 })).rejects.toThrow(/already running/);
  });
  it('enforces expected outflows and owner clearing through the control API', async () => {
    const { server, client, deliver } = await setup();
    await deliver(batch(block(98), block(99), block(100)));
    await client.check();
    await client.reserve({ id: 'pay', from: wallets.hot, to: wallets.merchant, amount: '1000000', nonce: hash(9) });
    await deliver(batch(block(101, [transferReceipt(101, { to: wallets.merchant, nonce: hash(9) })])));
    await client.check();
    await deliver(batch(block(102, [transferReceipt(102, { from: wallets.vault })])));
    await expect(client.check()).rejects.toThrow(/frozen/);
    const alert = server.monitor.status().alerts[0]!;
    await client.request('/unfreeze', { id: alert.id, reason: 'Reviewed controlled test' });
    await client.check();
  });
  it('provides receipt and authorization evidence without treating a missing index entry as unused', async () => {
    const { client, deliver } = await setup();
    const receipt = transferReceipt(101, { to: wallets.merchant, nonce: hash(9) });
    await deliver(batch(block(98), block(99), block(100), block(101, [receipt])));
    const fallback = { getTx: vi.fn(async () => null), authorizationUsed: vi.fn(async () => ({ used: true })), getUsdcBalance: vi.fn(async () => 100n) };
    const reader = new StreamChainReader(fallback, client);
    expect(await reader.getTx(receipt.transactionHash)).toMatchObject({ status: 'success', confirmations: 1 });
    expect(fallback.getTx).not.toHaveBeenCalled();
    expect(await reader.authorizationUsed(wallets.hot, hash(9))).toEqual({ used: true, txHash: receipt.transactionHash });
    expect(await reader.authorizationUsed(wallets.hot, hash(10))).toEqual({ used: true });
    expect(fallback.authorizationUsed).toHaveBeenCalledOnce();
    expect(await reader.getTx(hash(9999))).toBeNull();
    expect(fallback.getTx).toHaveBeenCalledOnce();
  });
  it('serves indexed ERC-20 activity once and falls back for other addresses', async () => {
    const { client, deliver } = await setup();
    await deliver(batch(block(98, [transferReceipt(98, { from: OTHER, to: wallets.hot })]), block(99), block(100)));
    const fallback = { getUsdcActivity: vi.fn(async () => []) };
    const reader = new StreamActivityReader(fallback, client);
    const activity = await reader.getUsdcActivity(wallets.hot, 10);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.amount).toBe(1_000_000n);
    await reader.getUsdcActivity(OTHER, 10);
    expect(fallback.getUsdcActivity).toHaveBeenCalledOnce();
  });
  it('tests, creates paused, configures the destination, and activates idempotently', async () => {
    const { client, dir } = await setup(false);
    const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, method: init!.method!, body: init!.body ? JSON.parse(String(init!.body)) : {} });
      return Response.json(path.endsWith('/test_filter') ? { logs: [], result: JSON.stringify(batch(block(20000))) } : { id: 'stream-1' });
    }) as typeof fetch;
    const opts = { client, directory: dir, key: 'test-provider-key', webhookUrl: 'https://example.com/webhooks/quicknode', backfillBlocks: 10_000, head: 20_000, fetchImpl };
    const config = await provisionStream(opts);
    expect(config).toMatchObject({ streamId: 'stream-1', startBlock: 10_001, liveBoundary: 20_000 });
    expect(calls[0]!.path).toMatch(/test_filter$/);
    const create = calls.find(c => c.path.endsWith('/streams'))!;
    expect(create.body).toMatchObject({ network: 'arc-testnet', dataset: 'block_with_receipts', status: 'paused', start_range: 10001, dataset_batch_size: 5, destination: 'webhook' });
    expect(create.body.destination_attributes).toMatchObject({ url: opts.webhookUrl, compression: 'none' });
    expect(calls.at(-1)!.path).toMatch(/activate$/);
    await provisionStream({ ...opts, head: 30_000 });
    expect(calls.filter(c => c.path.endsWith('/streams'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'setup.json'), 'utf8')).liveBoundary).toBe(20_000);
  });
  it('does not leak credentials in provider errors or accept insecure destinations', async () => {
    const { client, dir } = await setup(false);
    const opts = { client, directory: dir, key: 'sensitive', webhookUrl: 'https://example.com/webhooks/quicknode', backfillBlocks: 10000, head: 20000, fetchImpl: vi.fn(async () => Response.json({ echoed_key: 'sensitive' }, { status: 403 })) as typeof fetch };
    await expect(provisionStream(opts)).rejects.toThrow('QuickNode Streams API POST /streams/test_filter returned 403');
    await expect(provisionStream({ ...opts, webhookUrl: 'http://example.com/webhooks/quicknode' })).rejects.toThrow(/HTTPS/);
  });
  it('uses a trial account batch limit and accepts an empty successful activation response', async () => {
    const { client, dir } = await setup(false);
    const requests: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/test_filter')) return Response.json({ result: JSON.stringify(batch(block(20000))) });
      if (String(url).endsWith('/activate')) return new Response(null, { status: 201 });
      const body = JSON.parse(String(init!.body)); requests.push(body);
      if (body.dataset_batch_size === 5) return Response.json({ message: 'Dataset batch size is greater than max batch size: 5 > 1' }, { status: 500 });
      return Response.json({ id: 'trial-stream' });
    }) as typeof fetch;
    expect(await provisionStream({ client, directory: dir, key: 'private-key', webhookUrl: 'https://example.com/webhooks/quicknode', backfillBlocks: 10000, head: 20000, fetchImpl })).toMatchObject({ streamId: 'trial-stream' });
    expect(requests.map(r => r.dataset_batch_size)).toEqual([5, 1, 1]);
    expect(requests[0]!.external_id).toBe(requests[1]!.external_id);
  });
  it('does not return indexed receipts after a finalized-block integrity failure', async () => {
    const { server, client, deliver } = await setup();
    const receipt = transferReceipt(98, { from: OTHER, to: wallets.hot, nonce: hash(9) });
    await deliver(batch(block(98, [receipt]), block(99), block(100)));
    expect(() => server.monitor.ingest(batch({ ...block(100), hash: hash(555) }))).toThrow(/Conflicting/);
    expect(await client.request(`/receipt/${receipt.transactionHash}`)).toBeNull();
    expect((await client.status()).integrityError).toBe(true);
  });
});
