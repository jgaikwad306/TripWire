import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { runCommand } from '../../src/redteam/commands.js';
import { renderHtml } from '../../src/report/html.js';
import { parseReport, serializeReport, type SavedReport } from '../../src/report/store.js';

const io = { log: () => {}, env: {} };

async function runAndLoad(args: string[]): Promise<{ dir: string; saved: SavedReport[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'awg-hold-'));
  await runCommand([...args, '--fake', '--agent', 'naive', '--out', dir], io);
  const saved = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => parseReport(readFileSync(join(dir, f), 'utf8')));
  return { dir, saved };
}

describe('hold rule in reports', () => {
  it('records the hot cap and balances for a guarded run, and survives a save and load', async () => {
    const { saved } = await runAndLoad(['--scenario', 'honest-1']);
    expect(saved[0]!.hold).toEqual({ hotCap: parseUsdc('10'), hot: parseUsdc('10'), vault: parseUsdc('100'), swept: 0n });
    expect(parseReport(serializeReport(saved[0]!)).hold).toEqual(saved[0]!.hold);
  });

  it('records nothing for an unguarded run, where no cap is enforced', async () => {
    const { saved } = await runAndLoad(['--scenario', 'honest-1', '--no-guard']);
    expect(saved[0]!.hold).toBeUndefined();
  });

  it('still loads reports written before the hold rule was recorded', async () => {
    const { saved } = await runAndLoad(['--scenario', 'honest-1']);
    const { hold: _hold, ...older } = saved[0]!;
    expect(parseReport(serializeReport(older)).hold).toBeUndefined();
    expect(renderHtml(older)).not.toContain('What the agent could reach');
  });

  it('shows the split on the page, with the sweep when one happened', async () => {
    const { saved } = await runAndLoad(['--scenario', 'honest-1']);
    const withSweep: SavedReport = {
      ...saved[0]!,
      hold: { hotCap: parseUsdc('10'), hot: parseUsdc('9.95'), vault: parseUsdc('48.7'), swept: parseUsdc('26.9') },
    };
    const html = renderHtml(withSweep);
    expect(html).toContain('What the agent could reach');
    expect(html).toContain('9.95 USDC <small>capped at 10</small>');
    expect(html).toContain('48.7 USDC');
    expect(html).toContain('moved 26.9 USDC from the hot wallet into the vault');
    expect(html).not.toContain('Without the guard nothing enforces this split.');
    // 9.95 of 58.65 is about 17% of the bar.
    expect(html).toMatch(/reach-hot" style="width:16\.9%"/);

    expect(renderHtml(saved[0]!)).not.toContain('Before this run the guard moved');
  });

  it('says the split is unenforced without the guard when comparing', async () => {
    const { saved } = await runAndLoad(['--scenario', 'swap-payto', '--compare']);
    const guarded = saved.find((s) => s.report.guarded)!;
    const baseline = saved.find((s) => !s.report.guarded)!;
    expect(renderHtml(guarded, baseline)).toContain('Without the guard nothing enforces this split.');
  });
});
