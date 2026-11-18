import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RunManager } from '../../src/dashboard/manager.js';
import { guardRules } from '../../src/dashboard/guard-rules.js';

/** Execute the actual browser entrypoint against captured server events. The DOM stub
 * captures markup/text sinks; HTTP/SSE behavior is covered by live.test.ts. */
async function renderClient(config: unknown, snapshot: unknown, monitor: unknown = {}, globals: Record<string, unknown> = {}) {
  const elements = new Map<string, { innerHTML: string; textContent: string; hidden: boolean; style: Record<string, unknown>; value: string; className: string; querySelectorAll: () => never[]; addEventListener: () => void }>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: false, style: {}, value: '', className: '', querySelectorAll: () => [], addEventListener: () => {} });
    return elements.get(id)!;
  };
  runInNewContext(readFileSync(new URL('../../src/dashboard/client.js', import.meta.url), 'utf8'), {
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null },
    location: { search: '?token=test' }, URLSearchParams, CSS: { escape: (s: string) => s },
    requestAnimationFrame: (fn: () => void) => { queueMicrotask(fn); return 1; },
    fetch: async (url: string) => ({ ok: true, json: async () => url.startsWith('/api/config') ? config : url.startsWith('/api/streams') ? monitor : url.startsWith('/api/guard') ? guardRules('fake') : snapshot }),
    setInterval: () => 1,
    EventSource: class { addEventListener() {} close() {} },
    ...globals,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return elements;
}

describe('background ledger', () => {
  const browser = (scrollY: number, reduce: boolean) => {
    const listeners: Record<string, () => void> = {};
    const window = { scrollY, matchMedia: () => ({ matches: reduce, addEventListener: () => {} }), addEventListener: (type: string, fn: () => void) => { listeners[type] = fn; } };
    return { window, listeners };
  };
  const manager = () => new RunManager({ env: {} });

  it('moves the far layer up and the near layer sideways at fractions of the scroll, wrapped to one tile', async () => {
    // Arrange: 3000px down; far moves .12x on a 320px tile, near .2x on a 640px tile.
    const { window, listeners } = browser(3000, false);

    // Act
    const dom = await renderClient(manager().config(), manager().snapshot(), {}, { window });

    // Assert: 360 % 320 = 40 and 600 % 640 = 600, so neither layer outruns its tile.
    expect(dom.get('ledger-far')!.style.transform).toBe('translate3d(0, -40px, 0)');
    expect(dom.get('ledger-near')!.style.transform).toBe('translate3d(-600px, 0, 0)');
    expect(listeners.scroll).toBeTypeOf('function');
  });

  it('lets the hero chain trail the scroll up to a cap and runs the pending block border', async () => {
    // Arrange: lag is .3x of scroll, capped once the hero is long gone (1200px).
    const near = browser(400, false), far = browser(5000, false);

    // Act
    const shallow = await renderClient(manager().config(), manager().snapshot(), {}, { window: near.window });
    const deep = await renderClient(manager().config(), manager().snapshot(), {}, { window: far.window });

    // Assert
    expect(shallow.get('hero-chain')!.style.transform).toBe('translate3d(0, 120px, 0)');
    expect(shallow.get('chain-pending')!.style.strokeDashoffset).toBe('-80');
    expect(deep.get('hero-chain')!.style.transform).toBe('translate3d(0, 360px, 0)');
  });

  it('stays still when the reader prefers reduced motion', async () => {
    const { window } = browser(3000, true);

    const dom = await renderClient(manager().config(), manager().snapshot(), {}, { window });

    expect(dom.get('ledger-far')!.style.transform).toBe('translate3d(0, 0px, 0)');
    expect(dom.get('ledger-near')!.style.transform).toBe('translate3d(0px, 0, 0)');
    expect(dom.get('hero-chain')!.style.transform).toBe('translate3d(0, 0px, 0)');
  });
});

describe('how the guard works', () => {
  it('counts each attack the guard blocked under the rule that stopped it, and links the panel tag to that rule', { timeout: 30_000 }, async () => {
    // Arrange: a full fake comparison. Paid-API attacks: two stopped by resource, two by duplicate, one each by others.
    const manager = new RunManager({ env: {}, outDir: mkdtempSync(join(tmpdir(), 'tripwire-guard-')) });
    const completed = new Promise<void>((resolve) => manager.subscribe((event) => { if (event.type === 'run.completed') resolve(); }));
    manager.start({ network: 'fake', agent: 'naive', scenarioIds: manager.config().scenarios.map((s) => s.id) });
    await completed;
    const snapshot = JSON.parse(JSON.stringify(manager.snapshot(), (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
    // Select a paid-API attack (counts still come from every recorded result).
    snapshot.run.queue = ['api-prompt-injection'];

    // Act
    const dom = await renderClient(manager.config(), snapshot);

    // Assert: counts per rule, blank where nothing was blocked.
    const count = (check: string) => dom.get(`rule-count-${check}`)!.textContent;
    expect(count('resource')).toBe('blocked 2');
    expect(count('duplicate')).toBe('blocked 2');
    for (const check of ['intent-match', 'network', 'allowlist', 'price', 'budget']) expect(count(check)).toBe('blocked 1');
    for (const check of ['token', 'limits', 'rate-limit']) expect(count(check)).toBe('');
    // The selected paid-API attack's guard tag links to its rule; the unguarded column has none.
    const html = dom.get('comparison')!.innerHTML;
    expect(html.match(/<a class="check-tag rule-link" href="#rule-resource" data-rule="resource">resource<\/a>/g)).toHaveLength(1);
  });

  it('opens on the attack lab, and on the guard tab when the URL points at it or at a rule', async () => {
    const manager = new RunManager({ env: {} });
    const view = async (hash?: string) => {
      const dom = await renderClient(manager.config(), manager.snapshot(), {}, hash === undefined ? {} : { location: { search: '?token=test', hash } });
      return { lab: !dom.get('panel-lab')!.hidden, guard: !dom.get('panel-guard')!.hidden, selected: (dom.get('tab-guard') as unknown as { ariaSelected: string }).ariaSelected, sectionNav: !dom.get('section-nav')!.hidden };
    };

    expect(await view()).toEqual({ lab: true, guard: false, selected: 'false', sectionNav: true });
    expect(await view('#scenarios')).toEqual({ lab: true, guard: false, selected: 'false', sectionNav: true });
    expect(await view('#guard')).toEqual({ lab: false, guard: true, selected: 'true', sectionNav: false });
    expect(await view('#rule-duplicate')).toEqual({ lab: false, guard: true, selected: 'true', sectionNav: false });
  });

  it('renders every rule in order with its policy value', async () => {
    const manager = new RunManager({ env: {} });

    const dom = await renderClient(manager.config(), manager.snapshot());

    const list = dom.get('guard-rules')!.innerHTML;
    const order = [...list.matchAll(/<li class="guard-rule" id="rule-([a-z-]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(guardRules('fake').rules.map((r) => r.check));
    expect(list).toContain('market-data 0.001 · news-sentiment 0.002 · compute 0.005 USDC, up to 5% over');
  });
});

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
    expect(dom.get('attack-title')!.textContent).toBe('Prompt injection in paid data');
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

  it('shows the off-quote request as the agent action, not a later honest purchase', { timeout: 30_000 }, async () => {
    // Arrange: in fake-owner the agent first asks for 5 USDC to the attacker, then buys honestly.
    const manager = new RunManager({ env: {}, outDir: mkdtempSync(join(tmpdir(), 'tripwire-client-')) });
    const completed = new Promise<void>((resolve) => manager.subscribe((event) => { if (event.type === 'run.completed') resolve(); }));
    manager.start({ network: 'fake', agent: 'naive', scenarioIds: ['fake-owner'] });
    await completed;
    const snapshot = JSON.parse(JSON.stringify(manager.snapshot(), (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));

    // Act
    const html = (await renderClient(manager.config(), snapshot)).get('comparison')!.innerHTML;

    // Assert: both columns lead with the attack request and still count every attempt.
    expect(html.match(/Requested <strong>5 USDC<\/strong> to <strong class="coral">Attacker wallet<\/strong>/g)).toHaveLength(2);
    expect(html).not.toContain('Requested <strong>0.5 USDC</strong>');
    expect(html).toContain('2 payment requests observed');
  });
});
