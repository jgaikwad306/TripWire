import { describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/config.js';
import { API_RULES, guardRules } from '../../src/dashboard/guard-rules.js';
import { API_CHECKS } from '../../src/guard/api.js';
import { CHECK } from '../../src/guard/checks.js';
import { apiPolicy } from '../../src/redteam/world.js';

describe('guard rules shown on the dashboard', () => {
  it('lists the paid-API checks in the exact order evaluateApi runs them', () => {
    // Arrange
    const runOrder = API_CHECKS.map((check) => check.name);

    // Act
    const shown = API_RULES.map((rule) => rule.fn);

    // Assert
    expect(shown).toEqual(runOrder);
  });

  it('maps each check to the CHECK name its denials carry, in one place', () => {
    for (const [i, rule] of API_RULES.entries()) {
      // The check function's source names the CHECK it denies with.
      expect(API_CHECKS[i]!.toString()).toContain(`CHECK.${rule.key}`);
      expect(guardRules('fake').rules[i]!.check).toBe(CHECK[rule.key]);
    }
    // The four whose denial name differs from the function name.
    expect(API_RULES.filter((r) => r.fn.toLowerCase() !== `check${CHECK[r.key].replace('-', '')}`).map((r) => [r.fn, CHECK[r.key]])).toEqual([
      ['checkTask', 'intent-match'], ['checkAsset', 'token'], ['checkPayee', 'allowlist'], ['checkRate', 'rate-limit'],
    ]);
  });

  it('serves the values the run policy enforces, which match guard-policy.example.json', () => {
    // Arrange: the example policy's paid-API rules, resources aside (each run has its own API URL).
    const { resources: _file, ...example } = loadPolicy('guard-policy.example.json').api!;
    const { resources: _run, ...run } = apiPolicy('http://unused');

    // Act
    const values = Object.fromEntries(guardRules('fake').rules.map((r) => [r.check, r.value]));

    // Assert
    expect(run).toEqual(example);
    expect(values.price).toBe('market-data 0.001 · news-sentiment 0.002 · compute 0.005 USDC, up to 5% over');
    expect(values['rate-limit']).toBe('5 per endpoint per minute');
    expect(values.duplicate).toBe('Once per request within 2 min');
    expect(values.budget).toBe('market-research 0.005 · compute-job 0.01 USDC');
    expect(values.limits).toBe('2 USDC per payment · 20 USDC per day');
    expect(guardRules('arc-testnet').rules.find((r) => r.check === 'limits')!.value).toBe('0.2 USDC per payment · 2 USDC per day');
  });

  it('never includes an address, wallet ID or key', () => {
    const body = JSON.stringify(guardRules('arc-testnet'));
    expect(body).not.toMatch(/0x[0-9a-fA-F]{40}/);
    expect(body).not.toMatch(/WALLET_ID|PRIVATE_KEY|SECRET|API_KEY/);
  });
});
