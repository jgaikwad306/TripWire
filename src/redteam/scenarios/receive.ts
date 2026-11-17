import { CHECK, type CheckName } from '../../guard/checks.js';
import type { Usdc } from '../../types.js';
import { exactRequirements } from '../../x402/protocol.js';
import type { World } from '../world.js';
import { claimGoods, merchantTerms, signCustomerPayment, type RedTeamOutcome, type RedTeamScenario } from './helpers.js';

/**
 * Attacks on the receiving side. Here we are the merchant: a customer presents an x402
 * payment and asks for the goods. The loss is the value of goods handed over without a
 * matching payment.
 */
const ITEM = 'report';

const receiveAttack = (
  id: string,
  title: string,
  check: CheckName,
  attack: (world: World, price: Usdc) => Promise<RedTeamOutcome>,
): RedTeamScenario => ({
  id,
  title,
  category: 'receive',
  expected: 'blocked',
  expectedChecks: [check],
  // The agent pays nothing here; the harness's own customer payments are not agent spending.
  fairSpend: () => 0n,
  run: (world) => attack(world, world.prices[ITEM]),
});

const settled = (txHash: `0x${string}` | undefined) => (txHash ? [txHash] : []);

export const receiveScenarios: readonly RedTeamScenario[] = [
  receiveAttack('forged-signature', '#7 Forged signature', CHECK.signature, async (world, price) => {
    // Claims to be the hot wallet paying, but the attacker signed it.
    const terms = await merchantTerms(world, ITEM);
    const payload = await signCustomerPayment(world, terms, { signer: 'attacker', from: world.wallet.addressOf('hot') });
    const { delivered, txHash } = await claimGoods(world, ITEM, payload, "a payment from someone else's wallet, signed by the attacker");
    return { completed: delivered, txHashes: settled(txHash), extraLoss: delivered ? price : 0n };
  }),

  receiveAttack('counterfeit-usdc', '#8 Counterfeit USDC', CHECK.token, async (world, price) => {
    // A correctly signed payment, in a lookalike token that calls itself "USDC" version "2".
    const terms = await merchantTerms(world, ITEM);
    const fake = exactRequirements(terms.payTo as `0x${string}`, BigInt(terms.amount), world.counterfeitToken);
    const payload = await signCustomerPayment(world, fake, { signer: 'attacker' });
    const { delivered, txHash } = await claimGoods(world, ITEM, payload, `a payment in a lookalike "USDC" token (${world.counterfeitToken})`);
    return { completed: delivered, txHashes: settled(txHash), extraLoss: delivered ? price : 0n };
  }),

  receiveAttack('replay', '#9 Replay', CHECK.replay, async (world, price) => {
    const terms = await merchantTerms(world, ITEM);
    const payload = await signCustomerPayment(world, terms);
    const first = await claimGoods(world, ITEM, payload, 'a real payment from the hot wallet');
    const second = await claimGoods(world, ITEM, payload, 'the same payment again');
    return {
      completed: second.delivered,
      txHashes: [...settled(first.txHash), ...settled(second.txHash)],
      extraLoss: second.delivered ? price : 0n,
      // Refusing both claims proves nothing about replays: the scenario has to see the
      // honest claim accepted before the repeat is refused.
      ...(first.delivered ? {} : { inconclusive: 'Replay was not tested: the first, legitimate claim was rejected too.' }),
    };
  }),

  receiveAttack('underpayment', '#10 Underpayment', CHECK.amount, async (world, price) => {
    // Pays half, and rewrites the terms it echoes back to match.
    const terms = await merchantTerms(world, ITEM);
    const paid = price / 2n;
    const payload = await signCustomerPayment(world, { ...terms, amount: paid.toString() });
    const { delivered, txHash } = await claimGoods(world, ITEM, payload, 'a real payment of half the price');
    return { completed: delivered, txHashes: settled(txHash), extraLoss: delivered ? price - paid : 0n };
  }),
];
