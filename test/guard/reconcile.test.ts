import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { TransferRejectedError } from '../../src/errors.js';
import { FakeLedger } from '../../src/fakes/index.js';
import { CHECK } from '../../src/guard/checks.js';
import { MemoryReplayLedger, createGuard } from '../../src/guard/index.js';
import { defaultPolicy, type Policy } from '../../src/guard/policy.js';
import { MemoryGuardStore, type GuardStore } from '../../src/guard/store.js';
import type { Guard, WalletProvider } from '../../src/types.js';
import { CircleWallet, type CircleClientLike } from '../../src/wallet/circle.js';
import { LocalFacilitator } from '../../src/x402/facilitator.js';
import { exactRequirements } from '../../src/x402/protocol.js';
import { ATTACKER, CUSTOMER, MERCHANT, customerPayment } from './helpers.js';

type Transfer = WalletProvider['transfer'];

/** One ledger and one store, with as many guards as the test needs: each new guard is a restart. */
function world(overrides: Partial<Policy> = {}, payTo = MERCHANT) {
  const ledger = new FakeLedger({ hot: parseUsdc('10') });
  const inner = new MemoryGuardStore();
  /** Set to make every save that marks a payment as handed over fail, like a full disk. */
  const disk = { failsOnDelivery: false };
  const store: GuardStore = {
    load: () => inner.load(),
    save: (state) => {
      if (disk.failsOnDelivery && state.payments.some((p) => p.delivered)) throw new Error('disk full');
      inner.save(state);
    },
  };
  const wrap = (transfer: Transfer): WalletProvider => ({
    addressOf: (role) => ledger.addressOf(role),
    getBalance: (role) => ledger.getBalance(role),
    signTypedData: (role, data) => ledger.signTypedData(role, data),
    transfer,
  });
  const start = (wallet: WalletProvider = ledger): Guard =>
    createGuard({
      wallet,
      chain: ledger,
      store,
      fetchQuote: async (merchantUrl, item) => ({ merchantUrl, item, payTo, amount: parseUsdc(item === 'dataset' ? '2' : '0.5') }),
      facilitator: new LocalFacilitator(ledger.facilitatorSigner()),
      policy: defaultPolicy(ledger, overrides),
    });
  return { ledger, store, disk, wrap, start, merchantBalance: () => ledger.getBalance('merchant') };
}

async function buy(guard: Guard, item = 'report') {
  const intent = await guard.getQuote('fake://merchant', item);
  const request = { intentId: intent.id, payTo: intent.payTo, amount: intent.amount, reason: '' };
  return { intent, request, decision: await guard.requestPayment(request) };
}

describe('guard state survives a restart', () => {
  it('still counts what was spent before the restart against the daily cap', async () => {
    const w = world({ dailyCap: parseUsdc('3') });
    expect((await buy(w.start(), 'dataset')).decision.allowed).toBe(true);

    const afterRestart = await buy(w.start(), 'dataset');

    expect(afterRestart.decision).toMatchObject({ allowed: false, check: CHECK.limits });
    expect(await w.merchantBalance()).toBe(parseUsdc('2'));
  });

  it('still sees repeat payments made before the restart', async () => {
    const w = world({ loopMaxRepeats: 1 });
    await buy(w.start());

    expect((await buy(w.start())).decision).toMatchObject({ allowed: false, check: CHECK.loop });
  });

  it('still refuses a payment that was used before the restart', async () => {
    const w = world();
    w.ledger.fund(CUSTOMER, parseUsdc('5'));
    const terms = exactRequirements(MERCHANT, parseUsdc('2'));
    const payload = await customerPayment(terms);

    expect((await w.start().acceptPayment({ orderId: 'o-1', payload, requirements: terms })).allowed).toBe(true);
    expect(await w.start().acceptPayment({ orderId: 'o-2', payload, requirements: terms })).toMatchObject({
      allowed: false,
      check: CHECK.replay,
    });
  });
});

describe('reconciling a transfer whose outcome was not known', () => {
  it('charges once when the money was sent just before the process died', async () => {
    const w = world();
    const diesAfterSending = w.wrap(async (args) => {
      await w.ledger.transfer(args);
      throw new Error('process died');
    });
    const first = await buy(w.start(diesAfterSending));
    expect(first.decision).toMatchObject({ allowed: false, check: CHECK.wallet });
    expect(first.decision.reason).toMatch(/outcome is unknown/);

    const afterRestart = await buy(w.start());

    expect(afterRestart.decision.allowed).toBe(true);
    expect(afterRestart.decision.reason).toMatch(/recovered/);
    expect(await w.merchantBalance()).toBe(parseUsdc('0.5'));
    const payments = w.store.load().payments;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ state: 'sent', delivered: true, txHash: afterRestart.decision.txHash });
  });

  it('charges once when the process died after reserving and before sending', async () => {
    const w = world();
    w.store.save({
      intents: [],
      payments: [{ key: randomUUID(), intentId: 'intent-before-crash', item: 'report', payTo: MERCHANT, amount: parseUsdc('0.5'), at: Date.now(), state: 'reserved', delivered: false }],
      usedReceipts: [],
    });

    const afterRestart = await buy(w.start());

    expect(afterRestart.decision.allowed).toBe(true);
    expect(afterRestart.decision.reason).toMatch(/recovered/);
    expect(await w.merchantBalance()).toBe(parseUsdc('0.5'));
    expect(w.store.load().payments).toHaveLength(1);
  });

  it('refuses a new payment for the order while the earlier one still cannot be confirmed', async () => {
    const w = world();
    const guard = w.start(w.wrap(async () => { throw new Error('Circle API timeout'); }));
    expect((await buy(guard)).decision).toMatchObject({ allowed: false, check: CHECK.wallet });

    const again = await buy(guard);

    expect(again.decision).toMatchObject({ allowed: false, check: CHECK.reconcile });
    expect(await w.merchantBalance()).toBe(0n);
  });

  it('still lets a different order be paid while one is unconfirmed', async () => {
    const w = world();
    let down = true;
    const guard = w.start(w.wrap(async (args) => {
      if (down) throw new Error('Circle API timeout');
      return w.ledger.transfer(args);
    }));
    await buy(guard, 'report');
    down = false;

    expect((await buy(guard, 'dataset')).decision.allowed).toBe(true);
    expect(await w.merchantBalance()).toBe(parseUsdc('2'));
  });

  it('releases a payment the wallet definitely refused, so it can be tried again', async () => {
    const w = world({ dailyCap: parseUsdc('0.5') });
    let refusing = true;
    const guard = w.start(w.wrap(async (args) => {
      if (refusing) throw new TransferRejectedError('Circle transaction FAILED');
      return w.ledger.transfer(args);
    }));
    const first = await buy(guard);
    expect(first.decision).toMatchObject({ allowed: false, check: CHECK.wallet });
    expect(first.decision.reason).toMatch(/nothing was sent/);

    refusing = false;
    const retried = await guard.requestPayment(first.request);

    expect(retried.allowed).toBe(true);
    expect(await w.merchantBalance()).toBe(parseUsdc('0.5'));
  });

  it('hands a recovered payment over once; the next purchase pays again', async () => {
    const w = world();
    await buy(w.start(w.wrap(async (args) => { await w.ledger.transfer(args); throw new Error('process died'); })));
    const guard = w.start();

    const recovered = await buy(guard);
    const next = await buy(guard);

    expect(recovered.decision.reason).toMatch(/recovered/);
    expect(next.decision.allowed).toBe(true);
    expect(next.decision.txHash).not.toBe(recovered.decision.txHash);
    expect(await w.merchantBalance()).toBe(parseUsdc('1'));
  });

  it('still hands over a recovered transaction when recording that fails', async () => {
    const w = world();
    await buy(w.start(w.wrap(async (args) => { await w.ledger.transfer(args); throw new Error('process died'); })));
    const guard = w.start();
    const intent = await guard.getQuote('fake://merchant', 'report');
    w.disk.failsOnDelivery = true;

    const decision = await guard.requestPayment({ intentId: intent.id, payTo: intent.payTo, amount: intent.amount, reason: '' });

    expect(decision.allowed).toBe(true);
    expect(decision.txHash).toBeDefined();
    expect(await w.merchantBalance()).toBe(parseUsdc('0.5'));
  });

  it('treats a differently written item name as the same order', async () => {
    const w = world();
    const guard = w.start(w.wrap(async () => { throw new Error('Circle API timeout'); }));
    await buy(guard, 'report');

    expect((await buy(guard, ' Report ')).decision).toMatchObject({ allowed: false, check: CHECK.reconcile });
    expect(await w.merchantBalance()).toBe(0n);
  });

  it('does not send an unfinished payment to a payee no longer on the allowlist', async () => {
    const w = world({}, ATTACKER);
    w.store.save({
      intents: [],
      payments: [{ key: randomUUID(), intentId: 'intent-before-crash', item: 'report', payTo: ATTACKER, amount: parseUsdc('0.5'), at: Date.now(), state: 'reserved', delivered: false }],
      usedReceipts: [],
    });

    const afterRestart = await buy(w.start());

    expect(afterRestart.decision).toMatchObject({ allowed: false, check: CHECK.reconcile });
    expect(await w.ledger.getUsdcBalance(ATTACKER)).toBe(0n);
  });

  it('keeps receipts already in the store when the caller brings its own replay ledger', async () => {
    const w = world();
    w.store.save({ intents: [], payments: [], usedReceipts: ['0xabc'] });
    const guard = createGuard({
      wallet: w.ledger,
      chain: w.ledger,
      store: w.store,
      replayLedger: new MemoryReplayLedger(),
      fetchQuote: async (merchantUrl, item) => ({ merchantUrl, item, payTo: MERCHANT, amount: parseUsdc('0.5') }),
      policy: defaultPolicy(w.ledger),
    });

    await guard.getQuote('fake://merchant', 'report');

    expect(w.store.load().usedReceipts).toEqual(['0xabc']);
  });

  it('only hands a recovered payment to a request that matches the quote', async () => {
    const w = world();
    await buy(w.start(w.wrap(async (args) => { await w.ledger.transfer(args); throw new Error('process died'); })));
    const guard = w.start();
    const intent = await guard.getQuote('fake://merchant', 'report');

    const swapped = await guard.requestPayment({ intentId: intent.id, payTo: ATTACKER, amount: intent.amount, reason: '' });
    const honest = await guard.requestPayment({ intentId: intent.id, payTo: intent.payTo, amount: intent.amount, reason: '' });

    expect(swapped).toMatchObject({ allowed: false, check: CHECK.intentMatch });
    expect(swapped.txHash).toBeUndefined();
    expect(honest.reason).toMatch(/recovered/);
    expect(await w.ledger.getUsdcBalance(ATTACKER)).toBe(0n);
  });
});

describe('idempotent transfers', () => {
  it('FakeLedger: the same key returns the same transaction and moves the money once', async () => {
    const ledger = new FakeLedger({ hot: parseUsdc('10') });
    const args = { from: 'hot' as const, to: MERCHANT, amount: parseUsdc('1'), idempotencyKey: 'key-1' };

    const first = await ledger.transfer(args);
    const second = await ledger.transfer(args);
    const other = await ledger.transfer({ ...args, idempotencyKey: 'key-2' });

    expect(second.txHash).toBe(first.txHash);
    expect(other.txHash).not.toBe(first.txHash);
    expect(await ledger.getBalance('merchant')).toBe(parseUsdc('2'));
  });

  it('FakeLedger: a transfer it cannot make is a definite refusal', async () => {
    const ledger = new FakeLedger({ hot: parseUsdc('1') });
    await expect(ledger.transfer({ from: 'hot', to: MERCHANT, amount: parseUsdc('5') })).rejects.toBeInstanceOf(TransferRejectedError);
  });

  const WALLETS = {
    vault: { id: 'w-vault', address: '0x00000000000000000000000000000000000000a1' },
    hot: { id: 'w-hot', address: '0x00000000000000000000000000000000000000a2' },
    merchant: { id: 'w-merchant', address: '0x00000000000000000000000000000000000000a3' },
  } as const;

  function circle(state: { state: string; txHash?: string; errorReason?: string }) {
    const sent: Parameters<CircleClientLike['createTransaction']>[0][] = [];
    const client: CircleClientLike = {
      createWalletSet: async () => ({}),
      createWallets: async () => ({}),
      getWallet: async () => ({}),
      signTypedData: async () => ({}),
      createContractExecutionTransaction: async () => ({}),
      createTransaction: async (input) => {
        sent.push(input);
        return { data: { id: 'tx-1' } };
      },
      getTransaction: async () => ({ data: { transaction: state } }),
    };
    const wallet = new CircleWallet(client, new FakeLedger(), WALLETS, ATTACKER, { pollMs: 0, timeoutMs: 30 });
    return { wallet, sent };
  }

  it('CircleWallet: sends the idempotency key to Circle', async () => {
    const { wallet, sent } = circle({ state: 'CONFIRMED', txHash: `0x${'ab'.repeat(32)}` });
    await wallet.transfer({ from: 'hot', to: MERCHANT, amount: parseUsdc('1'), idempotencyKey: 'f1b9c7a2-0d1e-4c8e-9b1a-2f6d3c4e5a6b' });
    expect(sent[0]).toMatchObject({ idempotencyKey: 'f1b9c7a2-0d1e-4c8e-9b1a-2f6d3c4e5a6b' });
  });

  it('CircleWallet: a failed transaction is a definite refusal, a timeout is not', async () => {
    const failed = circle({ state: 'FAILED', errorReason: 'INSUFFICIENT_TOKEN_BALANCE' });
    await expect(failed.wallet.transfer({ from: 'hot', to: MERCHANT, amount: parseUsdc('1') })).rejects.toBeInstanceOf(TransferRejectedError);

    const stuck = circle({ state: 'QUEUED' });
    const error = await stuck.wallet.transfer({ from: 'hot', to: MERCHANT, amount: parseUsdc('1') }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TransferRejectedError);
  });
});
