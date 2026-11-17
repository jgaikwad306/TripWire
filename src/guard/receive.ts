import { USDC_ADDRESS, formatUsdc } from '../constants.js';
import type { Decision, ReceiptRequest, TxInfo } from '../types.js';
import { CHECK, allow, deny, includesAddress, sameAddress } from './checks.js';
import type { Policy } from './policy.js';

type Step = () => Decision | null;

/**
 * Receive-side checks, in order; the first failure rejects. Pure: the caller looks up
 * the transaction and the replay ledger and passes the results in. Each step stands on
 * its own (a missing transaction also fails the status step), so the red team's mutation
 * test can switch any one of them off and see what the others let through.
 */
export function evaluateReceipt(req: ReceiptRequest, tx: TxInfo | null, alreadyUsed: boolean, policy: Policy): Decision {
  const usdcTransfers = () => (tx?.transfers ?? []).filter((t) => sameAddress(t.token, USDC_ADDRESS));
  const receivedByUs = () =>
    usdcTransfers()
      .filter((t) => sameAddress(t.to, req.expectedTo))
      .reduce((sum, t) => sum + t.value, 0n);

  const steps: readonly Step[] = [
    () =>
      typeof req.expectedTo !== 'string' || !includesAddress(policy.receiveAddresses, req.expectedTo)
        ? deny(CHECK.recipient, `${String(req.expectedTo)} is not one of our receiving addresses.`)
        : null,
    // Runtime type check: a string here would make the comparisons below silently pass.
    () =>
      typeof req.expectedAmount !== 'bigint' || req.expectedAmount <= 0n
        ? deny(CHECK.amount, 'Expected amount must be a positive USDC amount in base units.')
        : null,
    () => (tx ? null : deny(CHECK.txExists, `Transaction ${req.txHash} does not exist onchain.`)),
    () =>
      !tx || tx.status !== 'success' || tx.confirmations < policy.minConfirmations
        ? deny(CHECK.txStatus, tx ? `Transaction is ${tx.status} with ${tx.confirmations} confirmation(s).` : 'Transaction not found.')
        : null,
    () =>
      usdcTransfers().length === 0
        ? deny(CHECK.token, 'Transaction moved no real USDC. Transfers of other tokens do not count.')
        : null,
    () =>
      usdcTransfers().some((t) => sameAddress(t.to, req.expectedTo))
        ? null
        : deny(CHECK.recipient, `The USDC in this transaction did not go to ${req.expectedTo}.`),
    () => {
      const received = receivedByUs();
      return typeof req.expectedAmount === 'bigint' && received < req.expectedAmount
        ? deny(CHECK.amount, `Received ${formatUsdc(received)} USDC, expected ${formatUsdc(req.expectedAmount)} USDC.`)
        : null;
    },
    () => (alreadyUsed ? deny(CHECK.replay, 'This transaction was already used to pay for another order.') : null),
  ];

  for (const step of steps) {
    const denial = step();
    if (denial) return denial;
  }
  return allow(`Received ${formatUsdc(receivedByUs())} USDC for order ${req.orderId}.`);
}
