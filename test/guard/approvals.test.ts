import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { FakeLedger } from '../../src/fakes/index.js';
import { ApprovalDesk, MAX_PENDING_APPROVALS } from '../../src/guard/approvals.js';
import { CHECK } from '../../src/guard/checks.js';
import { createGuard } from '../../src/guard/index.js';
import { defaultPolicy, parsePolicy, type Policy } from '../../src/guard/policy.js';
import type { PaymentIntent } from '../../src/types.js';
import { ATTACKER, MERCHANT, intentWith } from './helpers.js';

const MERCHANT_URL = 'fake://merchant';
const TTL = 120_000;

/** A guarded wallet with a 1 USDC approval threshold. "report" costs 0.5, "dataset" 2. */
function setup(overrides: Partial<Policy> = {}, approvalWaitMs = 0, payTo = MERCHANT) {
  const ledger = new FakeLedger({ hot: parseUsdc('10') });
  let clock = 1_000;
  const now = () => clock;
  const desk = new ApprovalDesk(now);
  const guard = createGuard({
    wallet: ledger,
    chain: ledger,
    fetchQuote: async (merchantUrl, item) => ({ merchantUrl, item, payTo, amount: parseUsdc(item === 'dataset' ? '2' : '0.5') }),
    policy: defaultPolicy(ledger, { approvalThreshold: parseUsdc('1'), ...overrides }),
    approvals: desk,
    approvalWaitMs,
    now,
  });
  const pay = (intent: PaymentIntent) =>
    guard.requestPayment({ intentId: intent.id, payTo: intent.payTo, amount: intent.amount, reason: 'please' });
  return {
    ledger,
    desk,
    guard,
    pay,
    quote: (item: string) => guard.getQuote(MERCHANT_URL, item),
    advance: (ms: number) => { clock += ms; },
    merchantBalance: () => ledger.getBalance('merchant'),
  };
}

describe('ApprovalDesk', () => {
  it('asks once per intent and shows the owner exactly what would be paid', () => {
    const desk = new ApprovalDesk(() => 1_000);
    const intent = intentWith({ id: 'intent-9', item: 'dataset', amount: parseUsdc('2'), merchantUrl: MERCHANT_URL });

    const first = desk.request(intent, TTL);
    const again = desk.request(intent, TTL);

    expect(again).toEqual(first);
    expect(desk.pending()).toEqual([
      { id: first.id, intentId: 'intent-9', merchantUrl: MERCHANT_URL, item: 'dataset', payTo: MERCHANT, amount: parseUsdc('2'), createdAt: 1_000, expiresAt: 1_000 + TTL, status: 'pending' },
    ]);
  });

  it('only lets a pending request be decided, and only once', () => {
    const desk = new ApprovalDesk(() => 1_000);
    const approval = desk.request(intentWith(), TTL);

    expect(desk.approve(approval.id).status).toBe('approved');
    expect(() => desk.approve(approval.id)).toThrow(/already approved/);
    expect(() => desk.deny(approval.id)).toThrow(/already approved/);
    expect(() => desk.approve('approval-missing')).toThrow(/No approval request/);
  });

  it('lets an approval be used once', () => {
    const desk = new ApprovalDesk(() => 1_000);
    const approval = desk.request(intentWith(), TTL);
    desk.approve(approval.id);

    expect(desk.consume(approval.id)).toBe(true);
    expect(desk.consume(approval.id)).toBe(false);
    expect(desk.forIntent('intent-1')?.status).toBe('used');
  });

  it('expires a request that was not decided, or an approval that was not used, in time', () => {
    let clock = 1_000;
    const desk = new ApprovalDesk(() => clock);
    const undecided = desk.request(intentWith({ id: 'a' }), TTL);
    const unused = desk.request(intentWith({ id: 'b' }), TTL);
    desk.approve(unused.id);

    clock += TTL + 1;

    expect(() => desk.approve(undecided.id)).toThrow(/expired/);
    expect(desk.consume(unused.id)).toBe(false);
    expect(desk.list().map((a) => a.status)).toEqual(['expired', 'expired']);
    expect(desk.pending()).toEqual([]);
  });
});

describe('guard: owner approval above a threshold', () => {
  it('pays without asking when no threshold is set', async () => {
    const world = setup({ approvalThreshold: undefined });
    const decision = await world.pay(await world.quote('dataset'));

    expect(decision).toMatchObject({ allowed: true, check: CHECK.ok });
    expect(world.desk.list()).toEqual([]);
  });

  it('pays without asking at or below the threshold', async () => {
    const world = setup({ approvalThreshold: parseUsdc('0.5') });
    const decision = await world.pay(await world.quote('report'));

    expect(decision.allowed).toBe(true);
    expect(world.desk.list()).toEqual([]);
  });

  it('holds a payment above the threshold and asks the owner', async () => {
    const world = setup();
    const decision = await world.pay(await world.quote('dataset'));

    expect(decision).toMatchObject({ allowed: false, check: CHECK.approval });
    expect(decision.reason).toMatch(/owner's approval/);
    expect(await world.merchantBalance()).toBe(0n);
    expect(world.desk.pending()).toMatchObject([{ item: 'dataset', payTo: MERCHANT, amount: parseUsdc('2'), merchantUrl: MERCHANT_URL }]);
  });

  it('pays once the owner has approved, and marks the approval used', async () => {
    const world = setup();
    const intent = await world.quote('dataset');
    await world.pay(intent);
    world.desk.approve(world.desk.pending()[0]!.id);

    const decision = await world.pay(intent);

    expect(decision).toMatchObject({ allowed: true, check: CHECK.ok });
    expect(await world.merchantBalance()).toBe(parseUsdc('2'));
    expect(world.desk.list()[0]!.status).toBe('used');
  });

  it('does not pay when the owner denies', async () => {
    const world = setup();
    const intent = await world.quote('dataset');
    await world.pay(intent);
    world.desk.deny(world.desk.pending()[0]!.id);

    const decision = await world.pay(intent);

    expect(decision).toMatchObject({ allowed: false, check: CHECK.approval });
    expect(decision.reason).toMatch(/denied/);
    expect(await world.merchantBalance()).toBe(0n);
  });

  it('does not pay on an approval that expired before it was used', async () => {
    const world = setup();
    const intent = await world.quote('dataset');
    await world.pay(intent);
    world.desk.approve(world.desk.pending()[0]!.id);
    world.advance(TTL + 1);

    const decision = await world.pay(intent);

    expect(decision).toMatchObject({ allowed: false, check: CHECK.approval });
    expect(decision.reason).toMatch(/expired/);
    expect(await world.merchantBalance()).toBe(0n);
  });

  it('does not let one approval cover a second purchase', async () => {
    const world = setup();
    const first = await world.quote('dataset');
    await world.pay(first);
    world.desk.approve(world.desk.pending()[0]!.id);
    await world.pay(first);

    expect(await world.pay(first)).toMatchObject({ allowed: false, check: CHECK.loop });
    expect(await world.pay(await world.quote('dataset'))).toMatchObject({ allowed: false, check: CHECK.approval });
    expect(await world.merchantBalance()).toBe(parseUsdc('2'));
  });

  it('never asks the owner about a payment the hard rules already forbid', async () => {
    const overCap = setup({ perTxCap: parseUsdc('1') });
    expect(await overCap.pay(await overCap.quote('dataset'))).toMatchObject({ allowed: false, check: CHECK.limits });
    expect(overCap.desk.list()).toEqual([]);

    const stranger = setup({}, 0, ATTACKER);
    expect(await stranger.pay(await stranger.quote('dataset'))).toMatchObject({ allowed: false, check: CHECK.allowlist });
    expect(stranger.desk.list()).toEqual([]);
  });

  it('still applies the hard rules to an approved payment', async () => {
    const world = setup({ dailyCap: parseUsdc('2.4') });
    const big = await world.quote('dataset');
    await world.pay(big);
    world.desk.approve(world.desk.pending()[0]!.id);
    // Spending in the meantime leaves too little of the daily cap for the approved payment.
    await world.pay(await world.quote('report'));

    expect(await world.pay(big)).toMatchObject({ allowed: false, check: CHECK.limits });
    expect(await world.merchantBalance()).toBe(parseUsdc('0.5'));
  });

  it('gives an approval its full time to be used, however late it was given', async () => {
    const world = setup();
    const intent = await world.quote('dataset');
    await world.pay(intent);
    world.advance(TTL - 1);
    world.desk.approve(world.desk.pending()[0]!.id);
    world.advance(TTL - 1);

    expect(await world.pay(intent)).toMatchObject({ allowed: true, check: CHECK.ok });
  });

  it('pays once when the same approved payment is requested twice at the same moment', async () => {
    const world = setup();
    const intent = await world.quote('dataset');
    await world.pay(intent);
    world.desk.approve(world.desk.pending()[0]!.id);

    const outcomes = await Promise.all([world.pay(intent), world.pay(intent)]);

    expect(outcomes.filter((d) => d.allowed)).toHaveLength(1);
    expect(await world.merchantBalance()).toBe(parseUsdc('2'));
  });

  it('pays the recorded quote even if the request names another payee or amount', async () => {
    const world = setup();
    const intent = await world.quote('dataset');
    await world.pay(intent);
    world.desk.approve(world.desk.pending()[0]!.id);

    const swapped = await world.guard.requestPayment({ intentId: intent.id, payTo: ATTACKER, amount: intent.amount, reason: '' });
    const inflated = await world.guard.requestPayment({ intentId: intent.id, payTo: intent.payTo, amount: parseUsdc('4'), reason: '' });

    expect(swapped).toMatchObject({ allowed: false, check: CHECK.intentMatch });
    expect(inflated).toMatchObject({ allowed: false, check: CHECK.intentMatch });
    expect(await world.ledger.getUsdcBalance(ATTACKER)).toBe(0n);
    expect(world.desk.list()[0]!.status).toBe('approved');
  });

  it('stops asking the owner once several requests are already waiting', async () => {
    const world = setup();
    for (let i = 0; i < MAX_PENDING_APPROVALS; i++) await world.pay(await world.quote('dataset'));

    const extra = await world.pay(await world.quote('dataset'));

    expect(extra).toMatchObject({ allowed: false, check: CHECK.approval });
    expect(extra.reason).toMatch(/Too many payments are already waiting/);
    expect(world.desk.pending()).toHaveLength(MAX_PENDING_APPROVALS);
  });

  it('can wait for the owner and then pay in the same request', async () => {
    const world = setup({}, 5_000);
    const payment = world.pay(await world.quote('dataset'));
    while (world.desk.pending().length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    world.desk.approve(world.desk.pending()[0]!.id);

    expect(await payment).toMatchObject({ allowed: true, check: CHECK.ok });
    expect(world.guard.decisions()).toHaveLength(1);
    expect(await world.merchantBalance()).toBe(parseUsdc('2'));
  });

  it('gives up waiting after the configured time without paying', async () => {
    const world = setup({}, 60);
    const decision = await world.pay(await world.quote('dataset'));

    expect(decision).toMatchObject({ allowed: false, check: CHECK.approval });
    expect(decision.reason).toMatch(/has not decided yet/);
    expect(await world.merchantBalance()).toBe(0n);
  });
});

describe('policy: approval settings', () => {
  const file = { allowlist: [MERCHANT], perTxCap: '5', dailyCap: '20', hotBalanceCap: '10' };

  it('reads the threshold and the expiry from the policy file', () => {
    const policy = parsePolicy({ ...file, approvalThreshold: '1.5', approvalTtlMs: 30_000 });
    expect(policy).toMatchObject({ approvalThreshold: parseUsdc('1.5'), approvalTtlMs: 30_000 });
  });

  it('leaves approval off by default, with a two-minute expiry ready', () => {
    const policy = parsePolicy(file);
    expect(policy.approvalThreshold).toBeUndefined();
    expect(policy.approvalTtlMs).toBe(TTL);
  });
});
