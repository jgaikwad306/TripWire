import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestJournal, loadJournal } from '../../src/dashboard/journal.js';
import { RunManager } from '../../src/dashboard/manager.js';

const finish = (manager: RunManager) =>
  new Promise<void>((resolve) => manager.subscribe((event) => { if (event.type === 'run.completed') resolve(); }));

describe('demo replay', () => {
  it('records a finished run and plays it back offline: same events, same reports, no keys needed', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'tripwire-replay-'));
    const live = new RunManager({ env: {}, outDir });
    const done = finish(live);
    live.start({ network: 'fake', agent: 'naive', scenarioIds: ['api-research', 'api-payee-swap'] });
    await done;
    await live.close();
    expect(readdirSync(join(outDir, 'runs')).some((name) => name.endsWith('-fake.journal.json'))).toBe(true);

    const journal = loadJournal(latestJournal(outDir)!);
    expect(journal.run.reports.guarded?.report.usdcLost).toBe(0n);

    const replay = new RunManager({ env: {}, outDir, replay: { journal, speed: 1000 } });
    // Nothing is configured, yet a replay of any network can start.
    expect(Object.values(replay.config().configured).every(Boolean)).toBe(true);
    const replayed = finish(replay);
    const run = replay.start({});
    await replayed;
    expect(run.warning).toMatch(/Replay of an offline run/);
    expect(run.status).toBe('completed');
    expect(run.events.map((e) => e.type)).toEqual(live.run!.events.map((e) => e.type));
    expect(run.reports.unguarded?.report.usdcLost).toBe(live.run!.reports.unguarded!.report.usdcLost);
  });
});
