import { USDC_ADDRESS, formatUsdc } from '../constants.js';
import type { Decision, ReceiptRequest, TxInfo } from '../types.js';
import { CHECK, allow, deny, includesAddress, sameAddress } from './checks.js';
import type { Policy } from './policy.js';

/**
 * Receive-side checks, in order; the first failure rejects. Pure: the caller looks up
 * the transaction and the replay ledger and passes the results in.
 */
export function evaluateReceipt(req: ReceiptRequest, tx: TxInfo | null, alreadyUsed: boolean, policy: Policy): Decision {
  if (typeof req.expectedTo !== 'string' || !includesAddress(policy.receiveAddresses, req.expectedTo)) {
    return deny(CHECK.recipient, `${String(req.expectedTo)} is not one of our receiving addresses.`);
  }
  // Runtime type check: a string here would make the comparisons below silently pass.
  if (typeof req.expectedAmount !== 'bigint' || req.expectedAmount <= 0n) {
    return deny(CHECK.amount, 'Expected amount must be a positive USDC amount in base units.');
  }
  if (!tx) {
    return deny(CHECK.txExists, `Transaction ${req.txHash} does not exist onchain.`);
  }
  if (tx.status !== 'success' || tx.confirmations < policy.minConfirmations) {
    return deny(CHECK.txStatus, `Transaction is ${tx.status} with ${tx.confirmations} confirmation(s).`);
  }

  const usdcTransfers = tx.transfers.filter((t) => sameAddress(t.token, USDC_ADDRESS));
  if (usdcTransfers.length === 0) {
    return deny(CHECK.token, 'Transaction moved no real USDC. Transfers of other tokens do not count.');
  }
  const toUs = usdcTransfers.filter((t) => sameAddress(t.to, req.expectedTo));
  if (toUs.length === 0) {
    return deny(CHECK.recipient, `The USDC in this transaction did not go to ${req.expectedTo}.`);
  }
  const received = toUs.reduce((sum, t) => sum + t.value, 0n);
  if (received < req.expectedAmount) {
    return deny(CHECK.amount, `Received ${formatUsdc(received)} USDC, expected ${formatUsdc(req.expectedAmount)} USDC.`);
  }
  if (alreadyUsed) {
    return deny(CHECK.replay, 'This transaction was already used to pay for another order.');
  }
  return allow(`Received ${formatUsdc(received)} USDC for order ${req.orderId}.`);
}
