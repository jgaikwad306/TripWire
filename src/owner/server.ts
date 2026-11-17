import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApprovalClosedError, UnknownApprovalError, type ApprovalDesk } from '../guard/approvals.js';
import { renderOwnerPage } from './page.js';

/**
 * The owner's console: a page on this machine listing payments that wait for approval.
 *
 * The agent can make HTTP requests of its own, including to localhost, so reaching this
 * server must not be enough to approve anything. Every route needs a random token that
 * is only ever printed to the owner's terminal, actions are POST only, and requests
 * addressed to any other host name are refused.
 */
export interface OwnerConsole {
  /** The page's address, token included. Show it to the owner and to nobody else. */
  url: string;
  token: string;
  close(): Promise<void>;
}

const TOKEN_BYTES = 24;
const ACTION_PATH = /^\/approvals\/([^/]+)\/(approve|deny)$/;

const sameToken = (given: string | null, expected: string): boolean => {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    // The page is static markup and forms: no scripts, no outside resources, no framing.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'x-frame-options': 'DENY',
    ...headers,
  });
  res.end(body);
}

export async function startOwnerConsole(desk: ApprovalDesk, opts: { port?: number } = {}): Promise<OwnerConsole> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  let allowedHosts: readonly string[] = [];

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    if (!allowedHosts.includes(req.headers.host ?? '')) return send(res, 403, 'Forbidden');
    const url = new URL(req.url ?? '/', 'http://owner');
    if (!sameToken(url.searchParams.get('token'), token)) return send(res, 403, 'Forbidden');

    if (url.pathname === '/') {
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed', { allow: 'GET' });
      return send(res, 200, renderOwnerPage(desk.list(), token, Date.now()), { 'content-type': 'text/html; charset=utf-8' });
    }

    const action = ACTION_PATH.exec(url.pathname);
    if (!action) return send(res, 404, 'Not found');
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed', { allow: 'POST' });
    const [, id = '', verb] = action;
    try {
      if (verb === 'approve') desk.approve(decodeURIComponent(id));
      else desk.deny(decodeURIComponent(id));
    } catch (err) {
      if (err instanceof UnknownApprovalError) return send(res, 404, err.message);
      if (err instanceof ApprovalClosedError) return send(res, 409, err.message);
      return send(res, 400, 'Bad request');
    }
    return send(res, 303, 'See other', { location: `/?token=${token}` });
  };

  // Anything can be sent here, including by the agent. A request this code cannot make
  // sense of gets a 400; it must never take the process down with it.
  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) send(res, 400, 'Bad request');
      else res.end();
    }
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];

  return {
    url: `http://127.0.0.1:${port}/?token=${token}`,
    token,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
