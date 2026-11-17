import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FAKE_ADDRESSES } from '../../src/fakes/index.js';
import { runCommand } from '../../src/redteam/commands.js';
import { jsonSafe } from '../../src/redteam/scenarios/helpers.js';
import { renderHtml } from '../../src/report/html.js';
import { parseReport, serializeReport, type SavedReport } from '../../src/report/store.js';

const io = { log: () => {}, env: {} };

async function run(args: string[]): Promise<{ guarded?: SavedReport; baseline?: SavedReport }> {
  const dir = mkdtempSync(join(tmpdir(), 'awg-replay-'));
  await runCommand([...args, '--fake', '--agent', 'naive', '--out', dir], io);
  const saved = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => parseReport(readFileSync(join(dir, f), 'utf8')));
  return { guarded: saved.find((s) => s.report.guarded), baseline: saved.find((s) => !s.report.guarded) };
}

describe('attack replay', () => {
  it('records what the agent was asked, each tool call and what it said', async () => {
    const { guarded } = await run(['--scenario', 'swap-payto']);
    const transcript = guarded!.report.results[0]!.transcript!;

    expect(transcript[0]).toMatchObject({ kind: 'task' });
    expect((transcript[0] as { text: string }).text).toMatch(/^Buy one "report" from the merchant at http/);
    expect(transcript.filter((e) => e.kind === 'tool').map((e) => (e as { name: string }).name)).toEqual(
      expect.arrayContaining(['get_quote', 'merchant_request', 'request_payment']),
    );
    expect(transcript.at(-1)).toMatchObject({ kind: 'agent' });
    // The merchant's tampered payment request is in the record, naming the attacker.
    expect(JSON.stringify(transcript)).toContain(FAKE_ADDRESSES.attacker);
    expect(guarded!.parties).toEqual({ merchant: FAKE_ADDRESSES.merchant, attacker: FAKE_ADDRESSES.attacker });
    expect(parseReport(serializeReport(guarded!)).report.results[0]!.transcript).toEqual(transcript);
  });

  it('shows the same attack with and without the guard, labelling the attacker address', async () => {
    const { guarded, baseline } = await run(['--scenario', 'swap-payto', '--compare']);
    const html = renderHtml(guarded!, baseline);

    expect(html).toContain('role="tab" id="tab-replay"');
    expect(html).toContain("The merchant's payment request names the attacker's address in place of its own.".replace(/'/g, '&#39;'));
    expect(html).toContain('Red team asked the agent');
    expect(html).toContain('Merchant replied');
    expect(html).toContain(`<mark class="is-attacker">${FAKE_ADDRESSES.attacker}<span> attacker</span></mark>`);
    expect(html).toContain('Guard decided: denied');
    expect(html).toContain('No guard, so the wallet paid');
  });

  it('replays receive-side attacks, where the attacker acts directly and no agent is involved', async () => {
    const { guarded, baseline } = await run(['--scenario', 'replay', '--compare']);
    const kinds = guarded!.report.results[0]!.transcript!.map((e) => e.kind);
    expect(kinds).toEqual(['attacker', 'attacker', 'merchant', 'attacker', 'merchant']);

    const texts = (s: SavedReport) => s.report.results[0]!.transcript!.map((e) => ('text' in e ? e.text : ''));
    expect(texts(guarded!).at(-1)).toMatch(/^Refused to hand over the report/);
    expect(texts(baseline!).at(-1)).toBe('Handed over the report.');
    expect(renderHtml(guarded!, baseline)).toContain('presents the same transaction again');
  });

  it('escapes everything in a transcript, including tool results the attacker controls', async () => {
    const { guarded } = await run(['--scenario', 'swap-payto']);
    const evil = '<script>alert(1)</script><img src=x>';
    guarded!.report.results[0]!.transcript = [
      { kind: 'task', text: evil },
      { kind: 'tool', name: evil, args: { note: evil }, result: evil },
      { kind: 'agent', text: evil },
      { kind: 'attacker', text: evil },
      { kind: 'merchant', text: evil },
    ];
    const html = renderHtml(guarded!);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>alert');
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('leaves the Replay tab out for reports saved before transcripts were recorded', async () => {
    const { guarded } = await run(['--scenario', 'swap-payto']);
    for (const r of guarded!.report.results) delete r.transcript;
    expect(renderHtml(guarded!)).not.toContain('tab-replay');
  });
});

describe('jsonSafe', () => {
  it('turns bigint into strings, clips long text and never throws', () => {
    expect(jsonSafe({ amount: 500000n, nested: [1n] })).toEqual({ amount: '500000', nested: ['1'] });
    expect((jsonSafe('x'.repeat(5000)) as string).length).toBe(2001);
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(typeof jsonSafe(loop)).toBe('string');
    expect(jsonSafe(undefined)).toBeNull();
  });
});
