import { createHmac } from 'node:crypto';

/**
 * Gemini private REST authentication (developer.gemini.com/authentication/api-key):
 * the JSON payload { request, nonce, ...fields } is base64-encoded into X-GEMINI-PAYLOAD,
 * X-GEMINI-SIGNATURE is hex(HMAC_SHA384(base64Payload, apiSecret)), and the HTTP body is empty.
 */
export interface GeminiCredentials {
  apiKey: string;
  apiSecret: string;
  /** Only master keys need this: the subaccount to act on. */
  account?: string;
}

/**
 * How the key was provisioned. 'time' (Gemini's recommendation): epoch seconds, within 30s of
 * Gemini's clock. 'increment': strictly increasing per key; we use milliseconds.
 */
export type NonceMode = 'time' | 'increment';

export class NonceSource {
  private last = 0;
  constructor(private readonly mode: NonceMode = 'time', private readonly clock: () => number = Date.now) {}

  next(): number {
    const now = this.mode === 'time' ? Math.floor(this.clock() / 1000) : this.clock();
    // Time-based nonces may repeat within a second; incremental ones must always grow.
    this.last = this.mode === 'increment' ? Math.max(now, this.last + 1) : now;
    return this.last;
  }
}

export function signRequest(path: string, fields: Record<string, unknown>, creds: GeminiCredentials, nonce: number): Record<string, string> {
  const payload = { request: path, nonce, ...(creds.account ? { account: creds.account } : {}), ...fields };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = createHmac('sha384', creds.apiSecret).update(encoded).digest('hex');
  return {
    'Content-Type': 'text/plain',
    'Content-Length': '0',
    'Cache-Control': 'no-cache',
    'X-GEMINI-APIKEY': creds.apiKey,
    'X-GEMINI-PAYLOAD': encoded,
    'X-GEMINI-SIGNATURE': signature,
  };
}
