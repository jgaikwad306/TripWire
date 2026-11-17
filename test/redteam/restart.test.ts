import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonFileGuardStore } from '../../src/guard/store.js';
import { buyCommand } from '../../src/redteam/commands.js';
import { parseReport } from '../../src/report/store.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'awg-restart-'));
  const statePath = join(dir, 'state', 'guard-state.json');
  const run = async (args: string[], crash?: () => void) => {
    const out = mkdtempSync(join(dir, 'run-'));
    const lines: string[] = [];
    await buyCommand([...args, '--fake', '--agent', 'naive', '--out', out, '--state', statePath], {
      log: (line) => lines.push(line),
      env: {},
      ...(crash ? { crash } : {}),
    });
    const json = readdirSync(out).find((f) => f.endsWith('.json'))!;
    return { result: parseReport(readFileSync(join(out, json), 'utf8')).report.results[0]!, output: lines.join('\n') };
  };
  return { statePath, run, payments: () => new JsonFileGuardStore(statePath).load().payments };
}

describe('buy: a restart in the middle of a purchase', () => {
  it('records the payment before sending, then finishes the purchase once after the restart', async () => {
    const { run, payments } = setup();
    // In a test the "crash" cannot end the process, so it throws out of the transfer instead.
    const crashed = await run(['--crash-after-send'], () => {
      throw new Error('simulated crash');
    });

    expect(crashed.output).toMatch(/Simulating a crash/);
    expect(crashed.result.passed).toBe(false);
    expect(payments()).toHaveLength(1);
    expect(payments()[0]!.state).not.toBe('sent');
    expect(payments()[0]!.delivered).toBe(false);

    const resumed = await run(['--resume']);

    expect(resumed.result).toMatchObject({ passed: true, usdcLost: 0n });
    expect(resumed.result.decisions.find((d) => d.txHash)?.reason).toMatch(/recovered/);
    expect(payments()).toHaveLength(1);
    expect(payments()[0]).toMatchObject({ state: 'sent', delivered: true });
  });

  it('starts a crash demonstration from a clean state file', async () => {
    const { run, payments, statePath } = setup();
    await run(['--crash-after-send'], () => { throw new Error('simulated crash'); });
    await run(['--crash-after-send'], () => { throw new Error('simulated crash'); });

    expect(payments()).toHaveLength(1);
    expect(readFileSync(statePath, 'utf8')).toContain('"version": 2');
  });

  it('has nothing to resume without a state file', async () => {
    const { run } = setup();
    await expect(run(['--resume'])).rejects.toThrow(/Nothing to resume/);
  });

  it('refuses to resume from a state file it cannot read', async () => {
    const { run, statePath } = setup();
    await run(['--crash-after-send'], () => { throw new Error('simulated crash'); });
    writeFileSync(statePath, '{ broken');

    await expect(run(['--resume'])).rejects.toThrow(/unreadable or corrupt/);
  });

  it('refuses the restart options without the guard', async () => {
    const { run } = setup();
    await expect(run(['--crash-after-send', '--no-guard'])).rejects.toThrow(/need the guard/);
    await expect(run(['--crash-after-send', '--resume'])).rejects.toThrow(/one of/);
  });
});
