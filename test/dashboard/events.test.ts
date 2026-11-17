import { describe, expect, it } from 'vitest';
import { NaiveAgent } from '../../src/redteam/naive-agent.js';
import { runScenario } from '../../src/redteam/runner.js';
import { findScenario } from '../../src/redteam/scenarios/index.js';
import { fakeWorldFactory } from '../../src/redteam/world.js';
import type { ExecutionEvent } from '../../src/events.js';
import { buildReport } from '../../src/redteam/score.js';
import { renderHtml } from '../../src/report/html.js';
import { renderMarkdown } from '../../src/report/render.js';

describe('execution observers', () => {
  it('cannot change payments or deliveries when an observer throws', async () => {
    const scenario = findScenario('honest-1')!;
    const result = await runScenario(scenario, fakeWorldFactory({ guarded: true, agent: new NaiveAgent() }), () => { throw new Error('viewer disconnected'); });
    expect(result.passed).toBe(true);
    expect(result.usdcLost).toBe(0n);
    expect(result.txHashes).toHaveLength(1);
    expect(result.transcript!.filter((e) => e.kind === 'tool').map((e) => e.name)).toEqual(['get_quote', 'merchant_request', 'request_payment']);
  });

  it('observes x402 signing and settlement without exposing reusable signatures', async () => {
    const events: ExecutionEvent[] = [];
    const result = await runScenario(findScenario('honest-1')!, fakeWorldFactory({ guarded: true, agent: new NaiveAgent() }), (event) => events.push(event));
    expect(result.passed).toBe(true);
    expect(events.some((e) => e.type === 'signature.started')).toBe(true);
    expect(events.some((e) => e.type === 'signature.completed')).toBe(true);
    const settled = events.findIndex((e) => e.type === 'settlement.completed');
    const delivered = events.findIndex((e) => e.type === 'delivery');
    expect(settled).toBeGreaterThan(events.findIndex((e) => e.type === 'settlement.started'));
    expect(delivered).toBeGreaterThan(settled);
    const receipt = events.find((e) => e.type === 'operation.started' && e.data.side === 'receive');
    expect(receipt?.data).toMatchObject({ request: { expectedAmount: '500000', payment: { value: '500000' } } });
    expect(JSON.stringify(events, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)).not.toMatch(/"signature"\s*:/);
  });

  it('keeps streamed evidence when the model fails after a tool call', async () => {
    const events: ExecutionEvent[] = [];
    const world = fakeWorldFactory({ guarded: true, agent: {
      name: 'failing-streamed-agent',
      async run(task, tools, sink) {
        const intent = await tools.getQuote(task.match(/http\S+/)![0], 'report');
        sink?.({ type: 'tool.completed', data: { callId: '1', call: { name: 'get_quote', args: {}, result: intent ?? { error: 'merchant unavailable' } } } });
        throw new Error('model unavailable');
      },
    } });
    const result = await runScenario(findScenario('swap-payto')!, world, (event) => events.push(event));
    expect(result.passed).toBe(false);
    expect(result.error).toContain('model unavailable');
    expect(result.transcript!.some((e) => e.kind === 'tool')).toBe(true);
    expect(events.some((e) => e.type === 'tool.completed')).toBe(true);
    expect(events.at(-1)!.type).toBe('scenario.completed');
  });

  it('marks a failed measurement as unknown rather than a verified zero loss', async () => {
    const base = fakeWorldFactory({ guarded: true, agent: new NaiveAgent() });
    const result = await runScenario(findScenario('honest-1')!, async (overrides, sink) => {
      const world = await base(overrides, sink);
      world.chain.getTx = async () => null;
      return world;
    });
    expect(result.measurementStatus).toBe('unknown');
    expect(result.passed).toBe(false);
    expect(result.error).toContain('loss is unknown');
    const saved = { network: 'fake' as const, report: buildReport([result], { agentName: 'naive', guarded: true, startedAt: new Date().toISOString() }) };
    expect(renderHtml(saved)).toContain('Some outcomes could not be measured');
    expect(renderHtml(saved)).not.toContain('and lost nothing');
    expect(renderMarkdown(saved)).toContain('unknown — score withheld');
  });
});
