import { describe, expect, it } from 'vitest';
import { USDC_ADDRESS, parseUsdc } from '../../src/constants.js';
import { FakeLedger } from '../../src/fakes/index.js';
import { CircleWallet, createWalletSet, loadWallets, type CircleClientLike } from '../../src/wallet/circle.js';
import { compileFakeUsdc } from '../../src/wallet/counterfeit.js';

const WALLETS = {
  vault: { id: 'w-vault', address: '0x00000000000000000000000000000000000000a1' },
  hot: { id: 'w-hot', address: '0x00000000000000000000000000000000000000a2' },
  merchant: { id: 'w-merchant', address: '0x00000000000000000000000000000000000000a3' },
} as const;
const ATTACKER = '0x00000000000000000000000000000000000000a4' as const;
const HASH = `0x${'ab'.repeat(32)}` as const;

/** Scripted Circle client: `states` is the sequence getTransaction returns. */
function fakeClient(states: { state: string; txHash?: string; errorReason?: string }[]) {
  const calls: Parameters<CircleClientLike['createTransaction']>[0][] = [];
  let i = 0;
  const client: CircleClientLike = {
    createWalletSet: async () => ({ data: { walletSet: { id: 'set-1' } } }),
    createWallets: async () => ({
      data: { wallets: Object.values(WALLETS).map((w) => ({ id: w.id, address: w.address })) },
    }),
    getWallet: async ({ id }) => {
      const wallet = Object.values(WALLETS).find((w) => w.id === id);
      return { data: wallet ? { wallet: { ...wallet } } : {} };
    },
    createTransaction: async (input) => {
      calls.push(input);
      return { data: { id: 'tx-1' } };
    },
    getTransaction: async () => ({ data: { transaction: states[Math.min(i++, states.length - 1)] } }),
  };
  return { client, calls };
}

const make = (states: Parameters<typeof fakeClient>[0], opts = { pollMs: 0, timeoutMs: 200 }) => {
  const { client, calls } = fakeClient(states);
  const chain = new FakeLedger({ hot: parseUsdc('10') });
  return { wallet: new CircleWallet(client, chain, WALLETS, ATTACKER, opts), calls };
};

describe('CircleWallet', () => {
  it('sends USDC on Arc Testnet as a decimal amount and waits for confirmation', async () => {
    const { wallet, calls } = make([{ state: 'INITIATED' }, { state: 'SENT', txHash: HASH }, { state: 'COMPLETE', txHash: HASH }]);
    const { txHash } = await wallet.transfer({ from: 'hot', to: WALLETS.merchant.address, amount: parseUsdc('1.5') });

    expect(txHash).toBe(HASH);
    expect(calls[0]).toMatchObject({
      walletId: 'w-hot',
      tokenAddress: USDC_ADDRESS,
      blockchain: 'ARC-TESTNET',
      amount: ['1.5'],
      destinationAddress: WALLETS.merchant.address,
    });
  });

  it('throws with the reason when Circle fails the transaction', async () => {
    const { wallet } = make([{ state: 'FAILED', errorReason: 'INSUFFICIENT_TOKEN_BALANCE' }]);
    await expect(wallet.transfer({ from: 'hot', to: ATTACKER, amount: 1n })).rejects.toThrow(/FAILED: INSUFFICIENT_TOKEN_BALANCE/);
  });

  it('times out instead of hanging when a transaction never confirms', async () => {
    const { wallet } = make([{ state: 'QUEUED' }], { pollMs: 5, timeoutMs: 30 });
    await expect(wallet.transfer({ from: 'hot', to: ATTACKER, amount: 1n })).rejects.toThrow(/Timed out.*QUEUED/);
  });

  it('refuses to send from the attacker or to send nothing', async () => {
    const { wallet, calls } = make([{ state: 'COMPLETE', txHash: HASH }]);
    await expect(wallet.transfer({ from: 'attacker', to: ATTACKER, amount: 1n })).rejects.toThrow(/watch-only/);
    await expect(wallet.transfer({ from: 'hot', to: ATTACKER, amount: 0n })).rejects.toThrow(/positive/);
    expect(calls).toHaveLength(0);
  });

  it('reads balances and addresses for every role', async () => {
    const { wallet } = make([]);
    expect(await wallet.getBalance('hot')).toBe(parseUsdc('10'));
    expect(await wallet.getBalance('attacker')).toBe(0n);
    expect(wallet.addressOf('attacker')).toBe(ATTACKER);
    expect(wallet.addressOf('vault')).toBe(WALLETS.vault.address);
  });
});

describe('wallet setup', () => {
  it('creates one wallet per role', async () => {
    const { walletSetId, wallets } = await createWalletSet(fakeClient([]).client);
    expect(walletSetId).toBe('set-1');
    expect(wallets).toEqual(WALLETS);
  });

  it('loads wallets from env and names the missing variable', async () => {
    const { client } = fakeClient([]);
    const env = { WALLET_ID_VAULT: 'w-vault', WALLET_ID_HOT: 'w-hot', WALLET_ID_MERCHANT: 'w-merchant' };
    expect(await loadWallets(client, env)).toEqual(WALLETS);
    await expect(loadWallets(client, { ...env, WALLET_ID_HOT: '' })).rejects.toThrow(/WALLET_ID_HOT/);
    await expect(loadWallets(client, { ...env, WALLET_ID_HOT: 'nope' })).rejects.toThrow(/no wallet with id nope/);
  });
});

describe('FakeUSDC contract', () => {
  it('compiles and mimics USDC metadata', () => {
    const { abi, bytecode } = compileFakeUsdc();
    expect(bytecode).toMatch(/^0x[0-9a-f]{100,}$/);
    const names = abi.flatMap((e) => ('name' in e ? [e.name] : []));
    expect(names).toEqual(expect.arrayContaining(['transfer', 'balanceOf', 'symbol', 'decimals', 'Transfer']));
  });
});
