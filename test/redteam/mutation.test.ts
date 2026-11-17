import { describe, expect, it, vi } from 'vitest';
import type { CheckName } from '../../src/guard/checks.js';
import type { Decision } from '../../src/types.js';

/**
 * Mutation test: is every guard check actually tested by the red team?
 *
 * Each case switches one check off (its denials stop happening) and runs the whole
 * offline suite with the scripted agent. The attack built for that check must then fail.
 * If one still passes, the red-team score is blind to that check, however well its unit
 * tests cover it.
 *
 * Checks are switched off by making `deny` return null for them. Every check is written
 * as "a denial, or null to carry on", so null means "this check let it through".
 */
const disabled = vi.hoisted(() => new Set<string>());

vi.mock('../../src/guard/checks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/guard/checks.js')>();
  return {
    ...actual,
    deny: (check: CheckName, reason: string): Decision =>
      disabled.has(check) ? (null as unknown as Decision) : actual.deny(check, reason),
  };
});

const { NaiveAgent } = await import('../../src/redteam/naive-agent.js');
const { runScenarios } = await import('../../src/redteam/runner.js');
const { ALL_SCENARIOS } = await import('../../src/redteam/scenarios/index.js');
const { fakeWorldFactory } = await import('../../src/redteam/world.js');

/** Each check, and the attacks that must fail once it is switched off. */
const MUTATIONS: Record<string, readonly string[]> = {
  'intent-match': ['swap-payto', 'inflate-price', 'prompt-injection', 'fake-owner', 'move-to-safety'],
  allowlist: ['rogue-merchant'],
  price: ['overpriced-quote'],
  limits: ['over-cap-quote', 'daily-cap-drain'],
  loop: ['payment-loop'],
  approval: ['self-approval'],
  signature: ['forged-signature'],
  token: ['counterfeit-usdc'],
  amount: ['underpayment'],
  replay: ['replay'],
};

async function failingWith(checks: readonly string[]): Promise<string[]> {
  disabled.clear();
  for (const check of checks) disabled.add(check);
  try {
    const results = await runScenarios(ALL_SCENARIOS, fakeWorldFactory({ guarded: true, agent: new NaiveAgent() }));
    return results.filter((r) => !r.passed).map((r) => r.id);
  } finally {
    disabled.clear();
  }
}

describe('mutation test: every guard check is exercised by an attack', () => {
  it('with no check switched off, nothing fails', async () => {
    expect(await failingWith([])).toEqual([]);
  });

  it('every check an attack is built to trip has a mutation here', () => {
    const named = new Set(ALL_SCENARIOS.flatMap((s) => s.expectedChecks ?? []));
    expect([...named].sort()).toEqual(Object.keys(MUTATIONS).sort());
  });

  it.each(Object.entries(MUTATIONS))('switching off %s makes its attacks fail', async (check, attacks) => {
    const failing = await failingWith([check]);
    expect(failing).toEqual(expect.arrayContaining([...attacks]));
    // Honest purchases must not depend on a check denying anything.
    expect(failing.filter((id) => ALL_SCENARIOS.find((s) => s.id === id)?.category === 'honest')).toEqual([]);
  });
});
