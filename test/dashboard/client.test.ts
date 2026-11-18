import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RunManager } from '../../src/dashboard/manager.js';

/** Execute the actual browser entrypoint against captured server events. The DOM stub
 * captures markup/text sinks; HTTP/SSE behavior is covered by live.test.ts. */
async function renderClient(config: unknown, snapshot: unknown, monitor: unknown = {}) {
  const elements = new Map<string, { innerHTML: string; textContent: string; hidden: boolean; style: Record<string, unknown>; value: string; className: string; querySelectorAll: () => never[]; addEventListener: () => void }>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: false, style: {}, value: '', className: '', querySelectorAll: () => [], addEventListener: () => {} });
    return elements.get(id)!;
  };
  runInNewContext(readFileSync(new URL('../../src/dashboard/client.js', import.meta.url), 'utf8'), {
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null },
    location: { search: '?token=test' }, URLSearchParams, CSS: { escape: (s: string) => s },
    requestAnimationFrame: (fn: () => void) => { queueMicrotask(fn); return 1; },
    fetch: async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/config') ? config : url.startsWith('/api/streams') ? monitor : snapshot }),
    setInterval: () => 1,
    EventSource: class { addEventListener() {} close() {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return elements;
}

describe('browser presentation', () => {
  it('shows monitor progress and freezes, preserving native precision and escaping alert details', async () => {
    const manager = new RunManager({ env: { QUICKNODE_STREAMS_ENABLED: 'true' } });
    const backfill = await renderClient(manager.config(), manager.snapshot(), { ready: false, reason: 'Stream backfill is incomplete', startBlock: 100, coveredThrough: 150, dataAgeSeconds: 300 });
    expect(backfill.get('streams-monitor')!.hidden).toBe(false);
    expect(backfill.get('streams-state')!.textContent).toBe('Spending blocked');
    expect(backfill.get('streams-coverage')!.textContent).toContain('backfill');
    expect(backfill.get('streams-coverage')!.textContent).toContain('100–150');
    expect(backfill.get('streams-coverage')!.textContent).toContain('300 seconds');
    const dom = await renderClient(manager.config(), manager.snapshot(), { frozen: true, reason: 'Spending frozen', alerts: [{ id: 'hash:0', amountNative: '1', to: '<img src=x>', reason: '<script>attack</script>' }] });
    expect(dom.get('streams-state')!.textContent).toBe('Spending frozen');
    expect(dom.get('streams-details')!.innerHTML).toContain('0.000000000000000001 USDC');
    expect(dom.get('streams-details')!.innerHTML).toContain('&lt;script&gt;');
    expect(dom.get('streams-details')!.innerHTML).not.toContain('<script>');
    const ready = await renderClient(manager.config(), manager.snapshot(), { ready: true, startBlock: 100, coveredThrough: 200 });
    expect(ready.get('streams-state')!.textContent).toBe('Monitoring live');
    expect(ready.get('streams-coverage')!.textContent).toContain('100–200');
  });
  it('renders the idle state and visibly explains missing configuration', async () => {
    const manager = new RunManager({ env: {} });
    const dom = await renderClient(manager.config(), manager.snapshot());
    expect(dom.get('comparison')!.innerHTML).toContain('With Tripwire');
    expect(dom.get('comparison')!.innerHTML).toContain('Without Tripwire');
    expect(dom.get('comparison')!.innerHTML).toContain('Waiting to run');
    expect(dom.get('notice')!.textContent).toContain('XAI_API_KEY');
    expect(dom.get('attack-title')!.textContent).toBe('Prompt injection');
  });

  it('renders a full comparison with actual payloads, safe markup, and accurately labeled receive attacks', { timeout: 30_000 }, async () => {
    const manager = new RunManager({ env: {}, outDir: mkdtempSync(join(tmpdir(), 'tripwire-client-')) });
    const completed = new Promise<void>((resolve) => manager.subscribe((event) => { if (event.type === 'run.completed') resolve(); }));
    manager.start({ network: 'fake', agent: 'naive', scenarioIds: manager.config().scenarios.map((s) => s.id) });
    await completed;
    expect(manager.run!.reports.guarded!.report.overall).toBe(100);
    expect(manager.run!.reports.unguarded!.report.overall).toBe(23);
    expect(manager.run!.reports.guarded!.report.results).toHaveLength(manager.config().scenarios.length);
    const snapshot = JSON.parse(JSON.stringify(manager.snapshot(), (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    for (const event of snapshot.run.events) {
      if (event.type === 'quote.recorded' && event.scenarioId === 'prompt-injection') event.data.intent.description = evil;
      if (event.type === 'guard.decision') event.data.decision.reason += evil;
    }
    // The browser initially selects prompt injection once a completed run is loaded.
    const dom = await renderClient(manager.config(), snapshot);
    const html = dom.get('comparison')!.innerHTML;
    expect(html).toContain('&lt;img');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(dom.get('evidence')!.innerHTML).not.toContain('<img');
    expect(html).toContain('Attack blocked by Tripwire');
    expect(html).toContain('USDC lost');
    expect(html).not.toContain('https://testnet.arcscan');
    expect(dom.get('metric-honest-note')!.textContent).toContain('100 guarded / 23 unguarded');
    snapshot.run.queue = ['counterfeit-usdc'];
    const receive = await renderClient(manager.config(), snapshot);
    const receiveHtml = receive.get('comparison')!.innerHTML;
    expect(receiveHtml).toContain('Attacker’s claim');
    expect(receiveHtml).toContain('USDC of goods lost');
    expect(receiveHtml).not.toContain('Observed agent action');
  });
});
