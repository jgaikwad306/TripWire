import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePolicy } from '../../src/guard/policy.js';
import { apiPolicy } from '../../src/redteam/world.js';

describe('guard-policy.example.json', () => {
  it('parses, and its paid-API rules are exactly the ones the red team runs against', () => {
    const policy = parsePolicy(JSON.parse(readFileSync('guard-policy.example.json', 'utf8')));
    const { resources: _shown, ...rules } = policy.api!;
    const { resources: _run, ...used } = apiPolicy('http://127.0.0.1:4030');
    expect(rules).toEqual(used);
  });

  it('rejects an api section that names no approved resource', () => {
    const raw = JSON.parse(readFileSync('guard-policy.example.json', 'utf8'));
    expect(() => parsePolicy({ ...raw, api: { ...raw.api, resources: [] } })).toThrow(/api\.resources/);
  });
});
