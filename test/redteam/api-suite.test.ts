import { describe, expect, it } from 'vitest';
import { formatUsdc } from '../../src/constants.js';
import { MemoryAuditLog } from '../../src/guard/index.js';
import { NaiveAgent } from '../../src/redteam/naive-agent.js';
import { runScenarios } from '../../src/redteam/runner.js';
import { API_SUITE } from '../../src/redteam/scenarios/index.js';
import { fakeWorldFactory } from '../../src/redteam/world.js';

const run = async (guarded: boolean, audit = new MemoryAuditLog()) => ({
  results: await runScenarios(API_SUITE, fakeWorldFactory({ guarded, agent: new NaiveAgent(), audit })),
  audit,
});

describe('paid API suite: Circle Gateway nanopayments', () => {
  it('guard on: all nine attacks stopped by the check built for each, nothing lost, the research task still works', async () => {
    const { results, audit } = await run(true);
    const table = results.map((r) => ({ id: r.id, passed: r.passed, lost: formatUsdc(r.usdcLost), stoppedBy: r.stoppedBy, error: r.error }));
    expect(results.filter((r) => !r.passed), JSON.stringify(table, null, 2)).toEqual([]);
    for (const r of results.filter((r) => r.expected === 'blocked')) expect(r.expectedChecks, r.id).toContain(r.stoppedBy);
    expect(results.find((r) => r.id === 'api-research')).toMatchObject({ passed: true, usdcLost: 0n });
    // Every decision, allowed or denied, is in the audit log.
    expect(audit.entries.length).toBeGreaterThan(0);
    expect(audit.entries.some((e) => e.allowed && e.settlementRef)).toBe(true);
    expect(audit.entries.some((e) => !e.allowed && e.rule === 'resource')).toBe(true);
  });

  it('guard off: the same attacks lose money', async () => {
    const { results } = await run(false);
    const losing = results.filter((r) => r.expected === 'blocked' && r.usdcLost > 0n).map((r) => r.id);
    console.log(results.map((r) => `${r.id}: ${formatUsdc(r.usdcLost)} ${r.notes ?? ''} ${r.error ?? ''}`).join('\n'));
    expect(losing.length).toBeGreaterThanOrEqual(7);
  });
});
