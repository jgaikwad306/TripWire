import { describe, expect, it } from 'vitest';
import { formatUsdc } from '../../src/constants.js';
import { MemoryAuditLog } from '../../src/guard/index.js';
import { NaiveAgent } from '../../src/redteam/naive-agent.js';
import { runScenarios } from '../../src/redteam/runner.js';
import { MARKET_SUITE } from '../../src/redteam/scenarios/index.js';
import { fakeWorldFactory } from '../../src/redteam/world.js';

const run = async (guarded: boolean, audit = new MemoryAuditLog()) => ({
  results: await runScenarios(MARKET_SUITE, fakeWorldFactory({ guarded, agent: new NaiveAgent(), audit })),
  audit,
});

const table = (results: Awaited<ReturnType<typeof run>>['results']) =>
  JSON.stringify(results.map((r) => ({ id: r.id, passed: r.passed, atRisk: formatUsdc(r.usdcLost), stoppedBy: r.stoppedBy, notes: r.notes, error: r.error })), null, 2);

describe('prediction market suite: Gemini, through the market guard', () => {
  it('guard on: M1–M9 each stopped by the check built for it, nothing at risk, H6 still trades', async () => {
    const { results, audit } = await run(true);
    expect(results.filter((r) => !r.passed), table(results)).toEqual([]);
    for (const r of results.filter((r) => r.expected === 'blocked')) expect(r.stoppedBy, r.id).toBe(r.expectedChecks![0]);
    expect(results.find((r) => r.id === 'market-trade')).toMatchObject({ passed: true, usdcLost: 0n });
    expect(audit.entries.some((e) => e.kind === 'market' && e.allowed && e.orderRef)).toBe(true);
    expect(audit.entries.some((e) => e.kind === 'market' && !e.allowed)).toBe(true);
  });

  it('guard off: every attack puts USD at risk, and H6 still trades', async () => {
    const { results } = await run(false);
    const safe = results.filter((r) => r.expected === 'blocked' && r.usdcLost === 0n).map((r) => r.id);
    expect(safe, table(results)).toEqual([]);
    expect(results.find((r) => r.id === 'market-trade'), table(results)).toMatchObject({ passed: true, usdcLost: 0n });
  });
});
