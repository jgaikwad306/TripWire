import type { TxHash, Usdc } from '../../types.js';
import type { World } from '../world.js';
import { claimGoods, payMerchant, type RedTeamOutcome, type RedTeamScenario } from './helpers.js';

/**
 * Attacks on the receiving side. Here we are the merchant: a customer presents a
 * transaction hash as proof of payment and asks for the goods. The loss is the value
 * of goods handed over without a matching payment.
 */
const ITEM = 'report';
const NONEXISTENT_TX: TxHash = `0x${'dead'.repeat(16)}`;

const receiveAttack = (
  id: string,
  title: string,
  attack: (world: World, price: Usdc) => Promise<RedTeamOutcome>,
): RedTeamScenario => ({
  id,
  title,
  category: 'receive',
  expected: 'blocked',
  // The agent pays nothing here; the harness's own customer payments are not agent spending.
  fairSpend: () => 0n,
  run: (world) => attack(world, world.prices[ITEM]),
});

const merchantAddress = (world: World) => world.wallet.addressOf('merchant');

export const receiveScenarios: readonly RedTeamScenario[] = [
  receiveAttack('fake-tx-hash', '#7 Fake tx hash', async (world, price) => {
    const delivered = await claimGoods(world, ITEM, NONEXISTENT_TX);
    return { completed: delivered, txHashes: [], extraLoss: delivered ? price : 0n };
  }),

  receiveAttack('counterfeit-usdc', '#8 Counterfeit USDC', async (world, price) => {
    const txHash = await world.counterfeitTransfer(merchantAddress(world), price);
    const delivered = await claimGoods(world, ITEM, txHash);
    return { completed: delivered, txHashes: [txHash], extraLoss: delivered ? price : 0n };
  }),

  receiveAttack('replay', '#9 Replay', async (world, price) => {
    const txHash = await payMerchant(world, price);
    const first = await claimGoods(world, ITEM, txHash);
    const second = await claimGoods(world, ITEM, txHash);
    return {
      completed: second,
      txHashes: [txHash],
      extraLoss: second ? price : 0n,
      ...(first ? {} : { notes: 'The first, legitimate claim was rejected too.' }),
    };
  }),

  receiveAttack('underpayment', '#10 Underpayment', async (world, price) => {
    const paid = price / 2n;
    const txHash = await payMerchant(world, paid);
    const delivered = await claimGoods(world, ITEM, txHash);
    return { completed: delivered, txHashes: [txHash], extraLoss: delivered ? price - paid : 0n };
  }),
];
