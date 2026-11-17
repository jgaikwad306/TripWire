import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { ApprovalDesk } from '../../src/guard/approvals.js';
import { startOwnerConsole, type OwnerConsole } from '../../src/owner/server.js';
import { MERCHANT, intentWith } from '../guard/helpers.js';

const TTL = 120_000;

describe('owner console', () => {
  let owner: OwnerConsole | undefined;
  afterEach(async () => {
    await owner?.close();
    owner = undefined;
  });

  async function start(item = 'dataset') {
    const desk = new ApprovalDesk();
    const approval = desk.request(intentWith({ item, amount: parseUsdc('2'), merchantUrl: 'http://merchant.example' }), TTL);
    owner = await startOwnerConsole(desk);
    const base = new URL(owner.url).origin;
    const action = (verb: string, token = owner!.token, method = 'POST') =>
      fetch(`${base}/approvals/${approval.id}/${verb}?token=${token}`, { method, redirect: 'manual' });
    return { desk, approval, base, action };
  }

  it('shows the owner the resource, the recipient and the amount', async () => {
    const { approval } = await start();
    const res = await fetch(owner!.url);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('dataset');
    expect(html).toContain('http://merchant.example');
    expect(html).toContain(MERCHANT);
    expect(html).toContain('2 USDC');
    expect(html).toContain(`/approvals/${approval.id}/approve?token=${owner!.token}`);
  });

  it('refuses every route without the token', async () => {
    const { desk, base, action } = await start();

    expect((await fetch(`${base}/`)).status).toBe(403);
    expect((await fetch(`${base}/?token=wrong`)).status).toBe(403);
    expect((await action('approve', 'wrong')).status).toBe(403);
    expect((await action('approve', '')).status).toBe(403);
    expect(desk.pending()).toHaveLength(1);
  });

  it('approves on POST and sends the owner back to the page', async () => {
    const { desk, action } = await start();
    const res = await action('approve');

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/?token=${owner!.token}`);
    expect(desk.list()[0]!.status).toBe('approved');
  });

  it('denies on POST', async () => {
    const { desk, action } = await start();
    await action('deny');
    expect(desk.list()[0]!.status).toBe('denied');
  });

  it('does not act on GET, so a link or an image cannot approve anything', async () => {
    const { desk, action } = await start();
    expect((await action('approve', owner!.token, 'GET')).status).toBe(405);
    expect(desk.pending()).toHaveLength(1);
  });

  it('answers clearly for an unknown or already decided request', async () => {
    const { base, action } = await start();
    expect((await fetch(`${base}/approvals/approval-missing/approve?token=${owner!.token}`, { method: 'POST' })).status).toBe(404);
    await action('approve');
    expect((await action('approve')).status).toBe(409);
  });

  it('escapes what the merchant chose, such as the item name', async () => {
    await start('<img src=x onerror=alert(1)>');
    const html = await (await fetch(owner!.url)).text();

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('refuses requests addressed to another host name', async () => {
    await start();
    const url = new URL(owner!.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers: { host: 'evil.example' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('survives a request it cannot parse and keeps serving', async () => {
    await start();
    const url = new URL(owner!.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: url.hostname, port: url.port, path: '//' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(400);
    expect((await fetch(owner!.url)).status).toBe(200);
  });

  it('refuses the right host name on the wrong port', async () => {
    await start();
    const url = new URL(owner!.url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers: { host: '127.0.0.1:1' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('sends headers that keep the page from being framed, cached or leaking its address', async () => {
    await start();
    const res = await fetch(owner!.url);

    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps existing requests where they are when a new one arrives', async () => {
    const { desk, approval } = await start();
    const later = desk.request(intentWith({ id: 'intent-2', item: 'second-item', amount: parseUsdc('3') }), TTL);
    const html = await (await fetch(owner!.url)).text();

    expect(html.indexOf(approval.id)).toBeGreaterThan(-1);
    expect(html.indexOf(approval.id)).toBeLessThan(html.indexOf(later.id));
  });

  it('trims a long item name and removes characters that hide or reorder text', async () => {
    await start(`Refund‮ evil${'x'.repeat(500)}`);
    const html = await (await fetch(owner!.url)).text();

    expect(html).not.toContain('‮');
    expect(html).not.toContain('x'.repeat(200));
    expect(html).toContain('…');
  });

  it('listens on the local machine only and uses a long random token', async () => {
    await start();
    expect(new URL(owner!.url).hostname).toBe('127.0.0.1');
    expect(owner!.token.length).toBeGreaterThanOrEqual(32);
  });
});
