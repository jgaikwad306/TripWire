import { describe, expect, it } from 'vitest';
import { redact } from '../../src/streams/commands.js';

describe('redact (QuickNode error messages)', () => {
  it('blanks secrets, the destination and anything credential-shaped, keeps the reason', () => {
    const token = 'tok_supersecretvalue';
    const message = `Destination https://a-b-c.trycloudflare.com/webhooks/quicknode?x=1 is not reachable (token ${token}, key 0123456789abcdef0123456789abcdef0)`;
    const out = redact(message, [token, 'https://a-b-c.trycloudflare.com/webhooks/quicknode', 'a-b-c.trycloudflare.com']);
    expect(out).toContain('is not reachable');
    expect(out).not.toContain(token);
    expect(out).not.toContain('trycloudflare');
    expect(out).not.toContain('0123456789abcdef');
  });

  it('caps the length', () => {
    expect(redact('x '.repeat(400), []).length).toBeLessThanOrEqual(301);
  });
});
