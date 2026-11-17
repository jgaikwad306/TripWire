import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, loadPolicy, requireEnv } from '../../src/config.js';
import { ARC_TESTNET, parseUsdc } from '../../src/constants.js';
import { JsonFileReplayLedger, MemoryReplayLedger } from '../../src/guard/intents.js';
import { parsePolicy } from '../../src/guard/policy.js';
import { MERCHANT, policyWith } from './helpers.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'guard-test-'));

const policyFile = (overrides: Record<string, unknown> = {}) => ({
  allowlist: [MERCHANT],
  perTxCap: '5',
  dailyCap: '20',
  hotBalanceCap: '10',
  ...overrides,
});

describe('parsePolicy', () => {
  it('parses decimal amounts into base units and applies defaults', () => {
    const policy = parsePolicy(policyFile({ expectedPrices: { report: '0.5' } }));

    expect(policy.perTxCap).toBe(parseUsdc('5'));
    expect(policy.expectedPrices).toEqual({ report: parseUsdc('0.5') });
    expect(policy.priceToleranceBps).toBe(500);
    expect(policy.loopMaxRepeats).toBe(2);
    expect(policy.receiveAddresses).toEqual([]);
  });

  it('rejects a malformed address', () => {
    expect(() => parsePolicy(policyFile({ allowlist: ['0x123'] }))).toThrow(/Invalid policy.*allowlist/s);
  });

  it('rejects an unparseable amount', () => {
    expect(() => parsePolicy(policyFile({ perTxCap: 'lots' }))).toThrow(/Invalid policy.*perTxCap/s);
  });

  it('rejects a zero cap', () => {
    expect(() => parsePolicy(policyFile({ dailyCap: '0' }))).toThrow(/Invalid policy.*dailyCap/s);
  });

  it('rejects unknown keys, so a typo cannot silently drop a limit', () => {
    expect(() => parsePolicy(policyFile({ perTxCapp: '1' }))).toThrow(/Invalid policy/);
  });

  it('returns a frozen policy', () => {
    const policy = parsePolicy(policyFile());
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.allowlist)).toBe(true);
    expect(Object.isFrozen(policy.expectedPrices)).toBe(true);
  });
});

describe('defaultPolicy', () => {
  it('allowlists the merchant wallet and freezes the result', () => {
    const policy = policyWith({ perTxCap: parseUsdc('1') });
    expect(policy.allowlist).toEqual([MERCHANT]);
    expect(policy.receiveAddresses).toEqual([MERCHANT]);
    expect(policy.perTxCap).toBe(parseUsdc('1'));
    expect(Object.isFrozen(policy)).toBe(true);
  });
});

describe('loadPolicy', () => {
  it('loads a policy file from disk', () => {
    const path = join(tempDir(), 'policy.json');
    writeFileSync(path, JSON.stringify(policyFile()));
    expect(loadPolicy(path).dailyCap).toBe(parseUsdc('20'));
  });

  it('loads the example policy shipped in the repo', () => {
    expect(loadPolicy('guard-policy.example.json').allowlist.length).toBeGreaterThan(0);
  });

  it('names the file when it is missing', () => {
    expect(() => loadPolicy('/nonexistent/policy.json')).toThrow(/Cannot read policy file.*nonexistent/);
  });

  it('names the file when it is not valid JSON', () => {
    const path = join(tempDir(), 'policy.json');
    writeFileSync(path, '{ not json');
    expect(() => loadPolicy(path)).toThrow(/not valid JSON/);
  });
});

describe('loadEnv', () => {
  it('treats empty values as missing and applies defaults', () => {
    const env = loadEnv({ CIRCLE_API_KEY: '', XAI_MODEL: 'some-model' });
    expect(env.CIRCLE_API_KEY).toBeUndefined();
    expect(env.XAI_MODEL).toBe('some-model');
    expect(env.ARC_RPC_URL).toBe(ARC_TESTNET.defaultRpcUrl);
    expect(env.MERCHANT_PORT).toBe(4020);
  });

  it('rejects a malformed RPC URL', () => {
    expect(() => loadEnv({ ARC_RPC_URL: 'not a url' })).toThrow(/Invalid environment.*ARC_RPC_URL/s);
  });

  it('requireEnv returns a present value and names a missing one', () => {
    const env = loadEnv({ XAI_API_KEY: 'key' });
    expect(requireEnv(env, 'XAI_API_KEY')).toBe('key');
    expect(() => requireEnv(env, 'CIRCLE_API_KEY')).toThrow(/CIRCLE_API_KEY/);
  });
});

describe('replay ledgers', () => {
  const HASH = `0x${'AB'.repeat(32)}` as const;

  it('memory ledger remembers hashes case-insensitively', () => {
    const ledger = new MemoryReplayLedger();
    expect(ledger.has(HASH)).toBe(false);
    ledger.add(HASH);
    expect(ledger.has(HASH.toLowerCase() as typeof HASH)).toBe(true);
  });

  it('file ledger persists across instances', () => {
    const path = join(tempDir(), 'nested', 'replay.json');
    new JsonFileReplayLedger(path).add(HASH);
    expect(new JsonFileReplayLedger(path).has(HASH)).toBe(true);
  });

  it('file ledger refuses a corrupt file rather than forgetting used hashes', () => {
    const path = join(tempDir(), 'replay.json');
    writeFileSync(path, '{"oops": true}');
    expect(() => new JsonFileReplayLedger(path)).toThrow(/replay ledger/i);
  });
});
