import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { buildReport } from '../../src/redteam/score.js';
import { renderHtml } from '../../src/report/html.js';
import type { SavedReport } from '../../src/report/store.js';
import type { ScenarioResult, TranscriptEntry } from '../../src/types.js';

const attack = (over: Partial<ScenarioResult> = {}): ScenarioResult => ({
  id: 'swap-payto',
  title: '#1 Swapped payTo',
  category: 'send',
  expected: 'blocked',
  passed: true,
  usdcLost: 0n,
  txHashes: [],
  decisions: [],
  ...over,
});

const saved = (guarded: boolean, result: ScenarioResult): SavedReport => ({
  network: 'fake',
  report: buildReport([result], { agentName: 'test-agent', guarded, startedAt: '2026-11-17T03:00:00.000Z' }),
});

const payment = (result: unknown): TranscriptEntry[] => [
  { kind: 'task', text: 'Buy one "report"' },
  { kind: 'tool', name: 'request_payment', args: { amount_usdc: '0.5' }, result },
];

const page = (guarded: boolean, result: unknown): string => renderHtml(saved(guarded, attack({ transcript: payment(result) })));

describe('replay labels for payment requests', () => {
  it('says the wallet paid only when an unguarded payment went through', () => {
    expect(page(false, { allowed: true, reason: 'No guard.', tx_hash: '0xab' })).toContain('No guard, so the wallet paid');
  });

  it('says the wallet could not pay when an unguarded payment failed', () => {
    const html = page(false, { allowed: false, reason: 'Insufficient balance' });
    expect(html).toContain('No guard, but the wallet could not pay');
    expect(html).not.toContain('No guard, so the wallet paid');
  });

  it('says the request never reached the wallet when the tool call itself was invalid', () => {
    const html = page(false, { error: 'pay_to is not a valid address' });
    expect(html).toContain('Request never reached the wallet');
    expect(html).not.toContain('No guard, so the wallet paid');
  });

  it('does not credit the guard with a decision it was never asked for', () => {
    const html = page(true, { error: 'pay_to is not a valid address' });
    expect(html).toContain('Request never reached the guard');
    expect(html).not.toContain('Guard decided');
  });

  it('keeps the guard labels for real decisions', () => {
    expect(page(true, { allowed: false, reason: 'Not on the allowlist.' })).toContain('Guard decided: denied');
    expect(page(true, { allowed: true, reason: 'ok', tx_hash: '0xab' })).toMatch(/<span class="who">Guard decided<\/span>/);
  });
});

describe('run headings', () => {
  it('keep "USDC" in capitals', () => {
    const lost = attack({ passed: false, usdcLost: parseUsdc('0.5'), transcript: payment({ allowed: true }) });
    const html = renderHtml(saved(false, lost));
    expect(html).toContain('Without the guard: lost 0.5 USDC');
    expect(html).not.toContain('0.5 usdc');
  });
});

describe('replay tab', () => {
  it('is shown when only the unguarded run has a transcript', () => {
    const guarded = saved(true, attack());
    const baseline = saved(false, attack({ passed: false, usdcLost: parseUsdc('0.5'), transcript: payment({ allowed: true }) }));
    const html = renderHtml(guarded, baseline);
    expect(html).toContain('id="tab-replay"');
    expect(html).toContain('No guard, so the wallet paid');
  });

  it('is left out when neither run has a transcript', () => {
    expect(renderHtml(saved(true, attack()), saved(false, attack()))).not.toContain('id="tab-replay"');
  });
});
