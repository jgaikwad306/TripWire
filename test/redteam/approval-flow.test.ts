import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES } from '../../src/fakes/index.js';
import { buyCommand } from '../../src/redteam/commands.js';
import { NaiveAgent } from '../../src/redteam/naive-agent.js';
import { runScenario } from '../../src/redteam/runner.js';
import { ALL_SCENARIOS, findScenario } from '../../src/redteam/scenarios/index.js';
import { fakeWorldFactory } from '../../src/redteam/world.js';
import { renderHtml } from '../../src/report/html.js';
import { parseReport, serializeReport } from '../../src/report/store.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('self-approval scenario', () => {
  const run = (guarded: boolean) =>
    runScenario(findScenario('self-approval')!, fakeWorldFactory({ guarded, agent: new NaiveAgent() }));

  it('is part of the full suite as an attack', () => {
    expect(ALL_SCENARIOS.find((s) => s.id === 'self-approval')).toMatchObject({ category: 'send', expected: 'blocked' });
  });

  it('with the guard: the payment waits for the owner and the agent cannot approve it itself', async () => {
    const result = await run(true);

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ passed: true, usdcLost: 0n, txHashes: [] });
    expect(result.decisions.length).toBeGreaterThanOrEqual(2);
    expect(result.decisions.every((d) => !d.allowed && d.check === 'approval')).toBe(true);
    const story = JSON.stringify(result.transcript);
    expect(story).toMatch(/owner's approval page/);
    expect(story).toMatch(/403/);
    expect(story).not.toMatch(/\b200\b/);
  });

  it('without the guard: the payment goes out with nobody asked', async () => {
    const result = await run(false);
    expect(result).toMatchObject({ passed: false, usdcLost: parseUsdc('2') });
  });
});

describe('buy --approve-above', () => {
  type Act = 'approve' | 'deny' | 'ignore';

  /** Plays the owner: opens the page whose address was printed and presses a button on it. */
  async function decide(pageUrl: string, verb: 'approve' | 'deny'): Promise<void> {
    for (let tries = 0; tries < 200; tries++) {
      try {
        const html = await (await fetch(pageUrl)).text();
        const action = new RegExp(`action="([^"]*/${verb}\\?token=[^"]*)"`).exec(html)?.[1];
        if (action) {
          await fetch(new URL(action.replace(/&amp;/g, '&'), pageUrl), { method: 'POST', redirect: 'manual' });
          return;
        }
      } catch {
        return; // The console has closed: the purchase is over.
      }
      await sleep(20);
    }
  }

  async function buy(args: string[], act: Act) {
    const dir = mkdtempSync(join(tmpdir(), 'awg-approve-'));
    const lines: string[] = [];
    let owner: Promise<void> | undefined;
    const log = (line: string) => {
      lines.push(line);
      const page = /Owner approval page: (http\S+)/.exec(line)?.[1];
      if (page && act !== 'ignore') owner = decide(page, act);
    };
    await buyCommand([...args, '--fake', '--agent', 'naive', '--out', dir], { log, env: {} });
    await owner;
    const json = readdirSync(dir).find((f) => f.endsWith('.json'))!;
    const saved = parseReport(readFileSync(join(dir, json), 'utf8'));
    return { saved, result: saved.report.results[0]!, output: lines.join('\n') };
  }

  it('waits for the owner, then pays and completes the purchase once approved', async () => {
    const { saved, result, output } = await buy(['--approve-above', '0.01'], 'approve');

    expect(output).toMatch(/Owner approval page: http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    expect(result).toMatchObject({ passed: true, usdcLost: 0n });
    expect(result.txHashes).toHaveLength(1);
    expect(result.decisions.find((d) => d.txHash)?.reason).toMatch(/The owner approved this payment\./);
    expect(saved.approvals).toEqual([
      { item: 'wallet-activity', merchantUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), payTo: FAKE_ADDRESSES.merchant, amount: parseUsdc('0.05'), status: 'used' },
    ]);
    expect(parseReport(serializeReport(saved)).approvals).toEqual(saved.approvals);
  });

  it('shows the approval on the purchase tab', async () => {
    const { saved } = await buy(['--approve-above', '0.01'], 'approve');
    const html = renderHtml(saved);

    expect(html).toContain('Owner approval');
    expect(html).toContain('Approved and paid');
    expect(html).toContain('0.05 USDC');
  });

  it('does not pay when the owner denies', async () => {
    const { saved, result } = await buy(['--approve-above', '0.01'], 'deny');

    expect(result.passed).toBe(false);
    expect(result.txHashes).toEqual([]);
    expect(result.decisions.at(-1)).toMatchObject({ allowed: false, check: 'approval' });
    expect(saved.approvals?.[0]?.status).toBe('denied');
  });

  it('does not pay when the owner does not answer in time', async () => {
    const { saved, result } = await buy(['--approve-above', '0.01', '--approval-wait', '0.2'], 'ignore');

    expect(result.passed).toBe(false);
    expect(result.txHashes).toEqual([]);
    expect(saved.approvals?.[0]?.status).toBe('pending');
  });

  it('does not ask about a purchase under the threshold', async () => {
    const { saved, result } = await buy(['--approve-above', '1'], 'ignore');

    expect(result.passed).toBe(true);
    expect(saved.approvals).toEqual([]);
  });

  it('refuses options that make no sense', async () => {
    const io = { log: () => {}, env: {} };
    await expect(buyCommand(['--approve-above', '0.01', '--no-guard', '--fake'], io)).rejects.toThrow(/needs the guard/);
    await expect(buyCommand(['--approve-above', 'lots', '--fake'], io)).rejects.toThrow(/Invalid USDC amount/);
    await expect(buyCommand(['--approve-above', '0.01', '--approval-wait', '-1', '--fake'], io)).rejects.toThrow(/--approval-wait/);
  });
});
