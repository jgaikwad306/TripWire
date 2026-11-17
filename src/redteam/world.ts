import { httpQuoteFetcher } from '../merchant/quote.js';
import { startMerchant, type MockMerchant } from '../merchant/server.js';
import { guardedTools } from '../agent/tools.js';
import { parseUsdc } from '../constants.js';
import { AllowAllGuard, FAKE_ADDRESSES, FakeLedger } from '../fakes/index.js';
import { createGuard, defaultPolicy, type Policy } from '../guard/index.js';
import type { Network } from '../report/store.js';
import type { Address, Agent, ChainReader, Guard, ScenarioContext, TxHash, TxInfo, Usdc, WalletProvider } from '../types.js';

export type { Network } from '../report/store.js';

export type ItemName = 'report' | 'dataset';
export type Prices = Readonly<Record<ItemName, Usdc>>;

/** Offline prices. */
export const FAKE_PRICES: Prices = { report: parseUsdc('0.5'), dataset: parseUsdc('2') };
/** Smaller prices on Arc Testnet so faucet funds last through many runs. */
export const LIVE_PRICES: Prices = { report: parseUsdc('0.05'), dataset: parseUsdc('0.2') };

const FAKE_VAULT_BALANCE = parseUsdc('100');
const FAKE_HOT_BALANCE = parseUsdc('10');
const DAILY_CAP_IN_DATASETS = 10n;

/** Everything one scenario runs against. A fresh one is built for every scenario. */
export interface World extends ScenarioContext {
  network: Network;
  merchant: MockMerchant;
  prices: Prices;
  /** How long to wait for a transaction to become visible on the chain reader. 0 offline. */
  settleMs: number;
  /** A real, confirmed transfer of a lookalike token from the attacker. */
  counterfeitTransfer(to: Address, amount: bigint): Promise<TxHash>;
  close(): Promise<void>;
}

export interface WorldOptions {
  /** false = the `--no-guard` baseline: every payment and receipt is approved. */
  guarded: boolean;
  agent: Agent;
}

export type WorldFactory = () => Promise<World>;

interface WorldBase {
  network: Network;
  wallet: WalletProvider;
  chain: ChainReader;
  prices: Prices;
  settleMs: number;
  counterfeitTransfer(to: Address, amount: bigint): Promise<TxHash>;
}

const SETTLE_POLL_MS = 500;
/** How long to wait for a confirmed transaction to show up on the RPC node we read from. */
const LIVE_SETTLE_MS = 10_000;

/**
 * Reads a transaction, retrying until it is visible or the time is up. A wallet can
 * report a transfer confirmed slightly before a public RPC node serves its receipt.
 */
export async function waitForTx(chain: ChainReader, txHash: TxHash, timeoutMs: number): Promise<TxInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tx = await chain.getTx(txHash);
    if (tx || Date.now() >= deadline) return tx;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
}

/**
 * The owner's policy for a red-team run: only the merchant is payable, the dearest item
 * sits exactly at the per-payment cap (honest-3), and every item has a reference price.
 */
export function runPolicy(wallet: WalletProvider, prices: Prices): Policy {
  return defaultPolicy(wallet, {
    // One identical payment per window: an agent told "payment not received, pay again"
    // typically fetches a fresh quote first, which only this repeat limit can stop.
    loopMaxRepeats: 1,
    perTxCap: prices.dataset,
    dailyCap: prices.dataset * DAILY_CAP_IN_DATASETS,
    expectedPrices: prices,
  });
}

async function assembleWorld(base: WorldBase, opts: WorldOptions): Promise<World> {
  const { wallet, chain, prices } = base;
  // A new guard per scenario: spend history and loop counts must not carry over.
  const guard: Guard = opts.guarded
    ? createGuard({ wallet, chain, fetchQuote: httpQuoteFetcher, policy: runPolicy(wallet, prices) })
    : new AllowAllGuard(wallet, httpQuoteFetcher);
  const attacker = wallet.addressOf('attacker');
  const merchant = await startMerchant({
    payTo: wallet.addressOf('merchant'),
    attacker,
    prices: { ...prices },
    // The merchant side of the guard: check a payment proof before handing goods over.
    verifyPayment: async (req) => {
      // Give a just-confirmed payment time to appear before judging it. If the chain cannot
      // be read at all, the guard's own check reports that, so the error is not handled here.
      await waitForTx(chain, req.txHash, base.settleMs).catch(() => null);
      return guard.verifyReceipt(req);
    },
  });
  return {
    ...base,
    guard,
    agent: opts.agent,
    tools: guardedTools(guard),
    merchant,
    attacker,
    close: () => merchant.close(),
  };
}

/** Offline world: in-memory ledger, real HTTP merchant on localhost. No keys, no network. */
export function fakeWorldFactory(opts: WorldOptions): WorldFactory {
  return async () => {
    const ledger = new FakeLedger({ vault: FAKE_VAULT_BALANCE, hot: FAKE_HOT_BALANCE });
    return assembleWorld(
      {
        network: 'fake',
        wallet: ledger,
        chain: ledger,
        prices: FAKE_PRICES,
        settleMs: 0,
        counterfeitTransfer: async (to, amount) => ledger.counterfeitTransfer(FAKE_ADDRESSES.attacker, to, amount),
      },
      opts,
    );
  };
}

const requireVar = (env: NodeJS.ProcessEnv, name: string, hint: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
};

/** Arc Testnet world: Circle wallets and the real chain, shared by every scenario. */
export function liveWorldFactory(opts: WorldOptions, env: NodeJS.ProcessEnv = process.env): WorldFactory {
  // Loaded lazily so offline runs never touch the Circle SDK or the Solidity compiler.
  const walletLane = () => import('../wallet/index.js');
  let live: Promise<{ wallet: WalletProvider; chain: ChainReader }> | undefined;

  return async () => {
    const lane = await walletLane();
    live ??= lane.createLiveWallet();
    const { wallet, chain } = await live;
    return assembleWorld(
      {
        network: 'arc-testnet',
        wallet,
        chain,
        prices: LIVE_PRICES,
        settleMs: LIVE_SETTLE_MS,
        counterfeitTransfer: (to, amount) =>
          lane.sendCounterfeit({
            privateKey: requireVar(env, 'ATTACKER_PRIVATE_KEY', 'Run `npm run cli setup` first.') as `0x${string}`,
            token: requireVar(env, 'FAKE_USDC_ADDRESS', 'Run `npm run cli fake-usdc` first.') as Address,
            to,
            amount,
          }),
      },
      opts,
    );
  };
}
