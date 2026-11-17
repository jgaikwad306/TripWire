import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RunManager } from '../../src/dashboard/manager.js';

/** Execute the actual browser entrypoint against captured server events. The DOM stub
 * captures markup/text sinks; HTTP/SSE behavior is covered by live.test.ts. */
async function renderClient(config: unknown, snapshot: unknown) {
  const elements = new Map<string, { innerHTML: string; textContent: string; hidden: boolean; style: Record<string, unknown>; value: string; className: string; querySelectorAll: () => never[]; addEventListener: () => void }>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: false, style: {}, value: '', className: '', querySelectorAll: () => [], addEventListener: () => {} });
    return elements.get(id)!;
  };
  runInNewContext(readFileSync(new URL('../../src/dashboard/client.js', import.meta.url), 'utf8'), {
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null },
    location: { search: '?token=test' }, URLSearchParams, CSS: { escape: (s: string) => s },
    requestAnimationFrame: (fn: () => void) => { queueMicrotask(fn); return 1; },
    fetch: async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/config') ? config : snapshot }),
    EventSource: class { addEventListener() {} close() {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return elements;
}

describe('browser presentation', () => {
  it('renders the idle state and visibly explains missing configuration', async () => {
    const manager = new RunManager({ env: {} });
    const dom = await renderClient(manager.config(), manager.snapshot());
    expect(dom.get('comparison')!.innerHTML).toContain('With Tripwire');
    expect(dom.get('comparison')!.innerHTML).toContain('Without Tripwire');
    expect(dom.get('comparison')!.innerHTML).toContain('Waiting to run');
    expect(dom.get('notice')!.textContent).toContain('XAI_API_KEY');
    expect(dom.get('attack-title')!.textContent).toBe('Prompt injection');
  });

  it('renders a full comparison with actual payloads, safe markup, and accurately labeled receive attacks', async () => {
    const manager = new RunManager({ env: {}, outDir: mkdtempSync(join(tmpdir(), 'tripwire-client-')) });
    const completed = new Promise<void>((resolve) => manager.subscribe((event) => { if (event.type === 'run.completed') resolve(); }));
    manager.start({ network: 'fake', agent: 'naive', scenarioIds: manager.config().scenarios.map((s) => s.id) });
    await completed;
    expect(manager.run!.reports.guarded!.report.overall).toBe(100);
    expect(manager.run!.reports.unguarded!.report.overall).toBe(20);
    expect(manager.run!.reports.guarded!.report.results).toHaveLength(19);
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
    expect(dom.get('metric-honest-note')!.textContent).toContain('100 guarded / 20 unguarded');
    snapshot.run.queue = ['counterfeit-usdc'];
    const receive = await renderClient(manager.config(), snapshot);
    const receiveHtml = receive.get('comparison')!.innerHTML;
    expect(receiveHtml).toContain('Attacker’s claim');
    expect(receiveHtml).toContain('USDC of goods lost');
    expect(receiveHtml).not.toContain('Observed agent action');
  });
});
