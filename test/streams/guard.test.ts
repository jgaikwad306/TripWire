import { describe, expect, it, vi } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { createFakeContext } from '../../src/fakes/index.js';
import { createGuard, defaultPolicy } from '../../src/guard/index.js';
import { MemoryGuardStore } from '../../src/guard/store.js';
import { ApprovalDesk } from '../../src/guard/approvals.js';
import { nonceFor } from '../../src/x402/protocol.js';
import { LocalFacilitator } from '../../src/x402/facilitator.js';
import type { SpendingSafety } from '../../src/streams/model.js';
import { customerPayment } from '../guard/helpers.js';
import { exactRequirements } from '../../src/x402/protocol.js';

function world(opts: { frozen?: boolean; failAfterSign?: boolean; approvals?: ApprovalDesk; threshold?: bigint; plain?: boolean; afterPayment?: () => void } = {}) {
  const state = { frozen: opts.frozen ?? false };
  const safety: SpendingSafety = {
    check: vi.fn(async () => { if (state.frozen) throw new Error('Spending frozen by monitor'); }),
    reserve: vi.fn(async () => { if (state.frozen) throw new Error('Spending frozen by monitor'); }),
    submitted: vi.fn(async () => {}),
  };
  const store = new MemoryGuardStore();
  const ctx = createFakeContext((ledger, merchant) => {
    const wallet = {
      addressOf: ledger.addressOf.bind(ledger), getBalance: ledger.getBalance.bind(ledger), transfer: ledger.transfer.bind(ledger),
      signTypedData: async (...args: Parameters<typeof ledger.signTypedData>) => {
        const signature = await ledger.signTypedData(...args);
        if (opts.failAfterSign) state.frozen = true;
        return signature;
      },
    };
    return createGuard({ wallet, chain: ledger, safety, store, approvals: opts.approvals,
      policy: defaultPolicy(wallet, { ...(opts.threshold === undefined ? {} : { approvalThreshold: opts.threshold }), loopMaxRepeats: 5 }),
      approvalWaitMs: opts.approvals ? 1000 : 0,
      fetchQuote: async (...args) => {
        const quote = await merchant.fetchQuote(...args);
        if (opts.plain) delete quote.requirements;
        return quote;
      },
      fetchImpl: async (...args) => { const response = await merchant.fetch(...args); opts.afterPayment?.(); return response; },
      facilitator: new LocalFacilitator(ledger.facilitatorSigner()),
    });
  });
  const pay = async () => {
    const intent = await ctx.guard.getQuote(ctx.merchant.url, 'report');
    return ctx.guard.requestPayment({ intentId: intent.id, payTo: intent.payTo, amount: intent.amount, reason: '' });
  };
  return { ...ctx, state, safety, store, pay };
}
describe('guard spending boundaries', () => {
  it('refuses fresh spending when monitoring is frozen or unavailable', async () => {
    const ctx = world({ frozen: true });
    expect(await ctx.pay()).toMatchObject({ allowed: false, check: 'monitoring' });
    expect(ctx.safety.reserve).not.toHaveBeenCalled();
    expect(await ctx.wallet.getBalance('merchant')).toBe(0n);
  });
  it('records the precise authorization before payment and binds plain transfers to their hash', async () => {
    const x402 = world();
    const decision = await x402.pay();
    expect(decision.allowed).toBe(true);
    const reserved = x402.store.load().payments[0]!;
    expect(x402.safety.reserve).toHaveBeenCalledWith({ id: reserved.key, from: x402.wallet.addressOf('hot'), to: x402.wallet.addressOf('merchant'), amount: '500000', nonce: nonceFor(reserved.key) });
    const plain = world({ plain: true });
    const paid = await plain.pay();
    expect(paid.allowed).toBe(true);
    expect(plain.safety.submitted).toHaveBeenCalledWith(plain.store.load().payments[0]!.key, paid.txHash);
  });
  it('rechecks after asynchronous signing before presenting a reusable signature', async () => {
    const ctx = world({ failAfterSign: true });
    expect(await ctx.pay()).toMatchObject({ allowed: false, check: 'monitoring' });
    expect(await ctx.wallet.getBalance('merchant')).toBe(0n);
  });
  it('rechecks after waiting for owner approval', async () => {
    const desk = new ApprovalDesk();
    const ctx = world({ approvals: desk, threshold: 1n });
    const paying = ctx.pay();
    await vi.waitFor(() => expect(desk.list()).toHaveLength(1));
    ctx.state.frozen = true;
    desk.approve(desk.list()[0]!.id);
    expect(await paying).toMatchObject({ allowed: false, check: 'monitoring' });
    expect(await ctx.wallet.getBalance('merchant')).toBe(0n);
  });
  it('reserves sweeps before transfer and prevents a frozen sweep', async () => {
    const ctx = world();
    ctx.ledger.fund(ctx.wallet.addressOf('hot'), parseUsdc('3'));
    await ctx.guard.rebalance();
    expect(ctx.safety.reserve).toHaveBeenCalledWith(expect.objectContaining({ to: ctx.wallet.addressOf('vault'), amount: '3000000' }));
    expect(ctx.safety.submitted).toHaveBeenCalledOnce();
    ctx.ledger.fund(ctx.wallet.addressOf('hot'), parseUsdc('3'));
    ctx.state.frozen = true;
    await expect(ctx.guard.rebalance()).rejects.toThrow(/frozen/);
    expect(await ctx.wallet.getBalance('hot')).toBe(parseUsdc('13'));
  });
  it('continues checking incoming receipts while outgoing spending is frozen', async () => {
    const ctx = world({ frozen: true });
    const requirements = exactRequirements(ctx.wallet.addressOf('merchant'), parseUsdc('0.5'));
    const payload = await customerPayment(requirements);
    const { from } = (payload.payload as { authorization: { from: `0x${string}` } }).authorization;
    ctx.ledger.fund(from, parseUsdc('1'));
    expect(await ctx.guard.acceptPayment({ orderId: 'incoming', requirements, payload })).toMatchObject({ allowed: true });
    expect(ctx.safety.reserve).not.toHaveBeenCalled();
  });
});
