import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MARKET_FOCUSED_SCENARIOS, scenarioCatalog } from '../../src/dashboard/catalog.js';
import { RunManager } from '../../src/dashboard/manager.js';
import { MarketBoardSource } from '../../src/dashboard/markets.js';
import { startDashboard, type DashboardServer } from '../../src/dashboard/server.js';
import { loadSnapshot } from '../../src/gemini/snapshot.js';
import type { MarketData } from '../../src/gemini/venue.js';
import { MARKET_SUITE } from '../../src/redteam/scenarios/index.js';

let server: DashboardServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const suite = MARKET_SUITE.map((s) => s.id);

describe('Prediction markets tab', () => {
  it('numbers the market scenarios M1–M9 and H6, with a story for each', () => {
    const market = scenarioCatalog().filter((s) => s.id.startsWith('market-'));
    expect(market.map((s) => s.number).sort()).toEqual(['H6', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']);
    expect(market.every((s) => s.goal !== 'Observe this scenario.')).toBe(true);
    expect(MARKET_FOCUSED_SCENARIOS.every((id) => suite.includes(id))).toBe(true);
  });

  it('serves the odds board only with the session token, from the snapshot when live data is off', async () => {
    const markets = new MarketBoardSource({ env: {}, live: false, suite, focused: MARKET_FOCUSED_SCENARIOS });
    server = await startDashboard({ manager: new RunManager({ env: {}, outDir: mkdtempSync(join(tmpdir(), 'tripwire-markets-')) }), markets });
    const url = new URL(server.url);
    expect((await fetch(`${url.origin}/api/markets`)).status).toBe(403);
    const board = await (await fetch(`${url.origin}/api/markets${url.search}`)).json();
    expect(board.source).toBe('snapshot');
    expect(board.event.contracts.some((c: { task: boolean }) => c.task)).toBe(true);
    expect(board.mandate.map((m: { label: string }) => m.label)).toContain('Task budget');
    expect(board.rules[0].check).toBe('market');
    expect(board.suite).toEqual(suite);
  });

  it('reads live data when it can, keeps history, and falls back to the snapshot', async () => {
    const snap = loadSnapshot();
    let clock = 0;
    let up = true;
    const data: MarketData = {
      listEvents: async () => snap.events,
      getEvent: async (ticker) => {
        if (!up) throw new Error('offline');
        return snap.events.find((e) => e.ticker === ticker)!;
      },
      getBook: async () => ({ bids: [], asks: [] }),
    };
    const source = new MarketBoardSource({ env: {}, live: true, data, suite, focused: [], now: () => clock });
    expect((await source.board()).source).toBe('live');
    clock += 20_000;
    up = false;
    const board = await source.board();
    expect(board.source).toBe('snapshot');
    expect(board.history).toHaveLength(2);
    source.stop();
  });
});
