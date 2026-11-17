import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { EMPTY_STATE, JsonFileGuardStore, MemoryGuardStore, type GuardState } from '../../src/guard/store.js';
import { MERCHANT, intentWith } from './helpers.js';

const TX = `0x${'ab'.repeat(32)}` as const;

const state: GuardState = {
  intents: [intentWith({ id: 'intent-1', amount: parseUsdc('2'), status: 'paid' })],
  payments: [
    { key: 'key-1', intentId: 'intent-1', item: 'report', payTo: MERCHANT, amount: parseUsdc('2'), at: 5, state: 'sent', txHash: TX, delivered: true },
    { key: 'key-2', intentId: 'intent-2', item: 'report', payTo: MERCHANT, amount: parseUsdc('0.5'), at: 9, state: 'unknown', delivered: false, error: 'timeout' },
  ],
  usedReceipts: [TX],
};

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'awg-state-')), 'nested', 'guard-state.json');

describe('MemoryGuardStore', () => {
  it('starts empty and returns what was saved', () => {
    const store = new MemoryGuardStore();
    expect(store.load()).toEqual(EMPTY_STATE);
    store.save(state);
    expect(store.load()).toEqual(state);
  });
});

describe('JsonFileGuardStore', () => {
  it('starts empty when there is no file yet', () => {
    expect(new JsonFileGuardStore(tempFile()).load()).toEqual(EMPTY_STATE);
  });

  it('gives the same state back to a new instance, as after a restart', () => {
    const path = tempFile();
    new JsonFileGuardStore(path).save(state);

    expect(new JsonFileGuardStore(path).load()).toEqual(state);
  });

  it('writes amounts as base-unit strings and leaves no temporary file behind', () => {
    const path = tempFile();
    new JsonFileGuardStore(path).save(state);
    const file = JSON.parse(readFileSync(path, 'utf8')) as { version: number; payments: { amount: string }[] };

    expect(file.version).toBe(1);
    expect(file.payments.map((p) => p.amount)).toEqual(['2000000', '500000']);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('refuses to start from a file it cannot read, so spending is never forgotten', () => {
    const path = tempFile();
    new JsonFileGuardStore(path).save(state);

    writeFileSync(path, '{ not json');
    expect(() => new JsonFileGuardStore(path).load()).toThrow(/unreadable or corrupt/);

    writeFileSync(path, JSON.stringify({ version: 1, intents: [], payments: [{ key: 'k', amount: 'lots' }], usedReceipts: [] }));
    expect(() => new JsonFileGuardStore(path).load()).toThrow(/unreadable or corrupt/);

    writeFileSync(path, JSON.stringify({ version: 2, intents: [], payments: [], usedReceipts: [] }));
    expect(() => new JsonFileGuardStore(path).load()).toThrow(/unreadable or corrupt/);
  });
});
