import { z } from 'zod';
import type { ExpectedOutflow, SpendingSafety } from './model.js';
import type { TxHash } from '../types.js';
import { dataDirectory, loadCredentials } from './server.js';
import type { StreamMonitor } from './monitor.js';

export function streamsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.QUICKNODE_STREAMS_ENABLED;
  if (value && !['true', 'false'].includes(value)) throw new Error('QUICKNODE_STREAMS_ENABLED must be true or false');
  return value === 'true';
}
export class StreamClient implements SpendingSafety {
  constructor(private readonly opts: { url?: string; token?: string; directory?: string; fetchImpl?: typeof fetch } = {}) {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    const url = new URL(this.opts.url ?? 'http://127.0.0.1:4022');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/') throw new Error('Streams control URL must be a local HTTP origin');
    try {
      const token = this.opts.token ?? loadCredentials(this.opts.directory ?? dataDirectory()).controlToken;
      const response = await (this.opts.fetchImpl ?? fetch)(new URL(path, url), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Monitor returned ${response.status}`);
      return await response.json() as T;
    } catch { throw new Error('Streams monitor unavailable; start `npm run cli streams serve` and inspect its status.'); }
  }
  status() { return this.request<ReturnType<StreamMonitor['status']>>('/status'); }
  async check(): Promise<void> {
    const status = z.object({ ready: z.boolean(), reason: z.string().optional() }).parse(await this.status());
    if (!status.ready) throw new Error(status.reason ?? 'Streams monitoring is not ready');
  }
  async reserve(outflow: ExpectedOutflow): Promise<void> { await this.request('/reserve', outflow); }
  async submitted(id: string, txHash: TxHash): Promise<void> { await this.request('/submitted', { id, txHash }); }
}
export const streamClient = (env: NodeJS.ProcessEnv = process.env) => new StreamClient({ directory: dataDirectory(env), url: env.QUICKNODE_STREAMS_CONTROL_URL });
