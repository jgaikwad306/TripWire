import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { handleLine, handleMessage, MCP_TOOLS, type McpServerOptions } from '../../src/mcp/server.js';
import { fakeWorldFactory, type World } from '../../src/redteam/world.js';
import type { Agent, AgentTools } from '../../src/types.js';

const unusedAgent: Agent = { name: 'mcp-client', run: () => Promise.reject(new Error('unused')) };

const noTools: AgentTools = {
  getQuote: () => Promise.reject(new Error('unused')),
  requestPayment: () => Promise.reject(new Error('unused')),
  checkBalance: async () => parseUsdc('3'),
};

const request = (id: number, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  ...(params ? { params } : {}),
});

/** Calls a tool and returns its parsed JSON result plus the isError flag. */
async function callTool(opts: McpServerOptions, name: string, args: Record<string, unknown> = {}) {
  const reply = await handleMessage(request(1, 'tools/call', { name, arguments: args }), opts);
  if (!reply || !('result' in reply)) throw new Error(`tools/call failed: ${JSON.stringify(reply)}`);
  const result = reply.result as { content: { type: string; text: string }[]; isError: boolean };
  return { value: JSON.parse(result.content[0]!.text) as Record<string, unknown>, isError: result.isError };
}

describe('MCP protocol', () => {
  const opts: McpServerOptions = { tools: noTools, instructions: 'Merchant at http://x' };

  it('negotiates the protocol version and announces tools', async () => {
    const reply = await handleMessage(request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} }), opts);
    expect(reply).toMatchObject({
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'tripwire-guard' },
        instructions: 'Merchant at http://x',
      },
    });
  });

  it('offers its newest version when the client asks for one it does not know', async () => {
    const reply = await handleMessage(request(1, 'initialize', { protocolVersion: '1999-01-01' }), opts);
    expect(reply).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
  });

  it('lists the same four tools the built-in agent has', async () => {
    const reply = await handleMessage(request(2, 'tools/list'), opts);
    const names = (reply as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toEqual(['get_quote', 'request_payment', 'check_balance', 'merchant_request']);
    expect(MCP_TOOLS.every((t) => t.inputSchema.type === 'object')).toBe(true);
  });

  it('does not answer notifications', async () => {
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, opts)).toBeUndefined();
  });

  it('reports unknown methods, unknown tools and bad JSON as errors', async () => {
    expect(await handleMessage(request(3, 'resources/list'), opts)).toMatchObject({ id: 3, error: { code: -32601 } });
    expect(await handleMessage(request(4, 'tools/call', { name: 'send_all' }), opts)).toMatchObject({
      id: 4,
      error: { code: -32602 },
    });
    expect(JSON.parse((await handleLine('{not json', opts))!)).toMatchObject({ id: null, error: { code: -32700 } });
    expect(await handleMessage({ id: 5, method: 'ping' }, opts)).toMatchObject({ id: 5, error: { code: -32600 } });
  });

  it('runs a tool and returns its result as text', async () => {
    expect(await callTool(opts, 'check_balance')).toEqual({ value: { balance_usdc: '3' }, isError: false });
  });

  it('marks a failed tool call with isError so the agent can react', async () => {
    const { value, isError } = await callTool(opts, 'request_payment', { intent_id: 'i', pay_to: 'nope', amount_usdc: '1', reason: '' });
    expect(isError).toBe(true);
    expect(value.error).toMatch(/pay_to/);
  });
});

describe('the guard over MCP, against the offline merchant', () => {
  let world: World | undefined;
  afterEach(async () => {
    await world?.close();
    world = undefined;
  });

  const connect = async (): Promise<{ world: World; opts: McpServerOptions }> => {
    world = await fakeWorldFactory({ guarded: true, agent: unusedAgent })();
    return { world, opts: { tools: world.tools } };
  };

  it('completes an honest purchase', async () => {
    const { world, opts } = await connect();
    const url = world.merchant.url;

    const quote = await callTool(opts, 'get_quote', { merchant_url: url, item: 'report' });
    const order = await callTool(opts, 'merchant_request', { merchant_url: url, method: 'POST', path: '/buy', body: { item: 'report' } });
    expect(order.value.status).toBe(402);
    const details = order.value.body as { payTo: string; amount: string };

    const paid = await callTool(opts, 'request_payment', {
      intent_id: quote.value.intent_id,
      pay_to: details.payTo,
      amount_usdc: quote.value.price_usdc,
      reason: 'buying the report',
    });
    expect(paid.value).toMatchObject({ allowed: true });

    const delivery = await callTool(opts, 'merchant_request', {
      merchant_url: url,
      method: 'POST',
      path: '/buy',
      body: { item: 'report', txHash: paid.value.tx_hash },
    });
    expect(delivery.value).toMatchObject({ status: 200, body: { delivered: true } });
  });

  it('refuses to pay the address a tampered 402 names, and nothing reaches the attacker', async () => {
    const { world, opts } = await connect();
    world.merchant.setMode('swap-payto');
    const url = world.merchant.url;
    const attacker = world.wallet.addressOf('attacker');
    const before = await world.chain.getUsdcBalance(attacker);

    const quote = await callTool(opts, 'get_quote', { merchant_url: url, item: 'report' });
    const order = await callTool(opts, 'merchant_request', { merchant_url: url, method: 'POST', path: '/buy', body: { item: 'report' } });
    const details = order.value.body as { payTo: string };
    expect(details.payTo.toLowerCase()).toBe(attacker.toLowerCase());

    const paid = await callTool(opts, 'request_payment', {
      intent_id: quote.value.intent_id,
      pay_to: details.payTo,
      amount_usdc: quote.value.price_usdc,
      reason: 'the merchant said to pay here',
    });

    expect(paid.value).toMatchObject({ allowed: false });
    expect(String(paid.value.reason)).toMatch(/does not match the recorded quote/);
    expect(await world.chain.getUsdcBalance(attacker)).toBe(before);
  });
});

describe('npm run cli mcp -- --fake', () => {
  it('speaks MCP over stdio to a real client process', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp', '--fake', '--attack', 'swap-payto'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const replies = createInterface({ input: child.stdout });
    const waiting = new Map<number, (msg: Record<string, unknown>) => void>();
    const stdoutLines: string[] = [];
    replies.on('line', (line) => {
      stdoutLines.push(line);
      const msg = JSON.parse(line) as { id: number };
      waiting.get(msg.id)?.(msg);
    });
    let nextId = 0;
    const send = (method: string, params?: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const id = ++nextId;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify(request(id, method, params))}\n`);
      });

    try {
      const init = (await send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } })) as {
        result: { instructions: string };
      };
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(init.result.instructions)![0];

      const call = async (name: string, args: Record<string, unknown>) => {
        const reply = (await send('tools/call', { name, arguments: args })) as { result: { content: { text: string }[] } };
        return JSON.parse(reply.result.content[0]!.text) as Record<string, unknown>;
      };
      const quote = await call('get_quote', { merchant_url: url, item: 'report' });
      const order = await call('merchant_request', { merchant_url: url, method: 'POST', path: '/buy', body: { item: 'report' } });
      const paid = await call('request_payment', {
        intent_id: quote.intent_id,
        pay_to: (order.body as { payTo: string }).payTo,
        amount_usdc: quote.price_usdc,
        reason: 'paying where the merchant said',
      });

      expect(paid).toMatchObject({ allowed: false });
      // Nothing but protocol messages on stdout.
      expect(stdoutLines.every((line) => JSON.parse(line).jsonrpc === '2.0')).toBe(true);
    } finally {
      child.stdin.end();
      await new Promise((resolve) => child.on('close', resolve));
    }
  }, 30_000);
});
