import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, FakeLedger, ScriptedAgent } from '../../src/fakes/index.js';
import { sweepHot } from '../../src/redteam/commands.js';
import { fakeWorldFactory } from '../../src/redteam/world.js';

const agent = new ScriptedAgent();

async function worldWithExtraHot(guarded: boolean, extra: string) {
  const world = await fakeWorldFactory({ guarded, agent })();
  (world.wallet as FakeLedger).fund(FAKE_ADDRESSES.hot, parseUsdc(extra));
  return world;
}

describe('sweepHot', () => {
  it('moves hot balance above the cap into the vault when guarded', async () => {
    const world = await worldWithExtraHot(true, '5');
    const lines: string[] = [];
    try {
      const vaultBefore = await world.wallet.getBalance('vault');
      const swept = await sweepHot(world, { log: (l) => lines.push(l), env: {} });

      expect(swept).toBe(parseUsdc('5'));
      expect(await world.wallet.getBalance('hot')).toBe(parseUsdc('10'));
      expect(await world.wallet.getBalance('vault')).toBe(vaultBefore + parseUsdc('5'));
      expect(lines.join('\n')).toMatch(/swept 5 USDC/);

      lines.length = 0;
      expect(await sweepHot(world, { log: (l) => lines.push(l), env: {} })).toBe(0n);
      expect(lines).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it('does nothing without a guard', async () => {
    const world = await worldWithExtraHot(false, '5');
    try {
      expect(await sweepHot(world, { log: () => {}, env: {} })).toBe(0n);
      expect(await world.wallet.getBalance('hot')).toBe(parseUsdc('15'));
    } finally {
      await world.close();
    }
  });
});
