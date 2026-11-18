import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentRunError } from '../../src/agent/errors.js';
import { REMOTE_PROTOCOL, RemoteAgent, type RemoteStepRequest } from '../../src/agent/remote.js';
import { runOnce } from '../../src/redteam/service.js';
import { findScenario } from '../../src/redteam/scenarios/index.js';
import type { AgentTools } from '../../src/types.js';

type Handler = (body: RemoteStepRequest, req: IncomingMessage, res: ServerResponse) => unknown;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

/** A deployed agent stand-in. Returns its URL and every step request it received. */
async function agentServer(handler: Handler): Promise<{ url: string; seen: { body: RemoteStepRequest; headers: IncomingMessage['headers'] }[] }> {
  const seen: { body: RemoteStepRequest; headers: IncomingMessage['headers'] }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as RemoteStepRequest;
    seen.push({ body: structuredClone(body), headers: req.headers });
    const reply = await handler(body, req, res);
    if (res.writableEnded) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof reply === 'string' ? reply : JSON.stringify(reply));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/step`, seen };
}

const stubTools: AgentTools = {
  getQuote: async () => { throw new Error('not used'); },
  requestPayment: async () => { throw new Error('not used'); },
  buyResource: async () => { throw new Error('not used'); },
  checkBalance: async () => 5_000_000n,
};

describe('RemoteAgent: a user-deployed agent over the step protocol', () => {
  it('drives the loop: sends the task and tools, runs the tool calls it asks for, returns its answer', async () => {
    const { url, seen } = await agentServer((body) =>
      body.step === 0 ? { tool_calls: [{ id: 'b1', name: 'check_balance', arguments: {} }] } : { message: 'I have 5 USDC.' },
    );
    const agent = new RemoteAgent({ url, name: 'mine:http', token: 's3cret' });
    const result = await agent.run('How much can I spend?', stubTools);

    expect(result.finalMessage).toBe('I have 5 USDC.');
    expect(result.toolCalls).toEqual([{ name: 'check_balance', args: {}, result: { balance_usdc: '5' } }]);
    expect(seen).toHaveLength(2);
    const [first, second] = seen.map((s) => s.body);
    expect(first!.protocol).toBe(REMOTE_PROTOCOL);
    expect(first!.task).toBe('How much can I spend?');
    expect(first!.tools.map((t) => t.function.name)).toContain('buy_resource');
    expect(first!.messages).toEqual([{ role: 'user', content: 'How much can I spend?' }]);
    expect(second!.run_id).toBe(first!.run_id);
    expect(second!.messages.slice(1)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'b1', name: 'check_balance', arguments: {} }] },
      { role: 'tool', tool_call_id: 'b1', name: 'check_balance', content: JSON.stringify({ balance_usdc: '5' }) },
    ]);
    expect(seen[0]!.headers.authorization).toBe('Bearer s3cret');
    expect(seen[0]!.headers['x-tripwire-protocol']).toBe(REMOTE_PROTOCOL);
  });

  it('accepts JSON-string arguments and feeds bad ones back as a tool error', async () => {
    const { url, seen } = await agentServer((body) =>
      body.step === 0
        ? { tool_calls: [{ name: 'check_balance', arguments: '{}' }, { name: 'check_balance', arguments: 'not json' }] }
        : { message: 'done' },
    );
    const result = await new RemoteAgent({ url, name: 'x' }).run('t', stubTools);
    expect(result.toolCalls.map((c) => c.result)).toEqual([{ balance_usdc: '5' }, { error: 'Arguments were not a JSON object' }]);
    const toolMessages = seen[1]!.body.messages.filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => 'tool_call_id' in m && m.tool_call_id)).toEqual(['call-0-0', 'call-0-1']);
  });

  it('keeps the tool calls already made when the agent fails part-way', async () => {
    const { url } = await agentServer((body, _req, res) => {
      if (body.step === 0) return { tool_calls: [{ name: 'check_balance' }] };
      res.writeHead(500).end('model exploded');
      return undefined;
    });
    const error = await new RemoteAgent({ url, name: 'x' }).run('t', stubTools).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentRunError);
    expect((error as AgentRunError).message).toContain('HTTP 500: model exploded');
    expect((error as AgentRunError).toolCalls).toHaveLength(1);
  });

  it('rejects replies that do not follow the protocol', async () => {
    const notJson = await agentServer(() => 'hello');
    await expect(new RemoteAgent({ url: notJson.url, name: 'x' }).run('t', stubTools)).rejects.toThrow(/not JSON/);
    const wrongShape = await agentServer(() => ({ tool_calls: [{ arguments: {} }] }));
    await expect(new RemoteAgent({ url: wrongShape.url, name: 'x' }).run('t', stubTools)).rejects.toThrow(/tool_calls\.0\.name/);
  });

  it('refuses too many tool calls in one step rather than running part of them', async () => {
    const { url } = await agentServer(() => ({ tool_calls: Array.from({ length: 3 }, () => ({ name: 'check_balance' })) }));
    const error = await new RemoteAgent({ url, name: 'x', maxToolCallsPerStep: 2 }).run('t', stubTools).catch((e: unknown) => e);
    expect((error as AgentRunError).message).toMatch(/3 tool calls in one step; the limit is 2/);
    expect((error as AgentRunError).toolCalls).toHaveLength(0);
  });

  it('stops a looping agent at the step limit', async () => {
    const { url, seen } = await agentServer(() => ({ tool_calls: [{ name: 'check_balance' }] }));
    const result = await new RemoteAgent({ url, name: 'x', maxSteps: 3 }).run('t', stubTools);
    expect(result.finalMessage).toMatch(/limit of 3 steps/);
    expect(seen).toHaveLength(3);
  });

  it('gives up on an oversized reply and on a hung endpoint', async () => {
    const big = await agentServer(() => ({ message: 'x'.repeat(16_000), pad: 'y'.repeat(300_000) }));
    await expect(new RemoteAgent({ url: big.url, name: 'x' }).run('t', stubTools)).rejects.toThrow(/larger than/);
    const hung = await agentServer(() => new Promise(() => {}));
    await expect(new RemoteAgent({ url: hung.url, name: 'x', timeoutMs: 200 }).run('t', stubTools)).rejects.toThrow(AgentRunError);
  });

  it('runs a red-team scenario end to end: buys the research data through the guard', async () => {
    // A minimal deployed agent: buy every URL the task names, then summarise what came back.
    const { url } = await agentServer((body) => {
      if (body.step === 0) {
        const urls = body.task.match(/https?:\/\/\S+/g) ?? [];
        return { tool_calls: urls.map((u, i) => ({ id: `buy-${i}`, name: 'buy_resource', arguments: { url: u } })) };
      }
      const paid = body.messages.filter((m) => m.role === 'tool' && JSON.parse(m.content).allowed).length;
      return { message: `Bought ${paid} resources.` };
    });
    const saved = await runOnce({
      scenarios: [findScenario('api-research')!],
      guarded: true,
      fake: true,
      agent: new RemoteAgent({ url, name: 'deployed:http' }),
      outDir: mkdtempSync(join(tmpdir(), 'tripwire-remote-')),
      io: { env: {}, log: () => {} },
    });
    const [result] = saved.report.results;
    console.log(JSON.stringify(result, (_k, v) => typeof v === "bigint" ? String(v) : v, 1).slice(0, 3000));
    expect(saved.report.agentName).toBe('deployed:http');
    expect({ passed: result!.passed, notes: result!.notes, error: result!.error, transcript: result!.transcript }).toMatchObject({ passed: true });
    expect(result!.transcript?.find((e) => e.kind === 'agent')).toEqual({ kind: 'agent', text: 'Bought 2 resources.' });
  });
});
