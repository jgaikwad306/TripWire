import { USDC_ADDRESS, formatUsdc } from '../constants.js';
import type { Decision, IncomingPayment, ReceiptRequest, TxInfo } from '../types.js';
import { ARC_NETWORK, type Eip3009Authorization } from '../x402/protocol.js';
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

/** What the guard works out about an x402 payment before judging it. */
export interface IncomingFacts {
  /** The signed EIP-3009 part, or undefined when the payload is not one. */
  signed: { authorization: Eip3009Authorization } | undefined;
  /** Did the signature recover to the payer, over the USDC domain we asked to be paid in? */
  signatureValid: boolean;
  /** Has this authorization already paid for an order here? */
  alreadyUsed: boolean;
  /** Unix seconds. */
  now: number;
}

const sameText = (a: unknown, b: unknown): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Receive-side checks on an x402 payment, before anything is settled. Pure: the caller
 * recovers the signature and looks up the replay ledger. `requirements` are what we asked
 * for; everything in the payload is the payer's claim. The steps stand on their own, so
 * switching one off (the mutation test) leaves the rest working.
 */
export function evaluateIncoming(req: IncomingPayment, facts: IncomingFacts, policy: Policy): Decision {
  const { requirements, payload } = req;
  const accepted = payload?.accepted;
  const auth = facts.signed?.authorization;
  const steps: readonly Step[] = [
    () =>
      includesAddress(policy.receiveAddresses, requirements.payTo as `0x${string}`)
        ? null
        : deny(CHECK.recipient, `${requirements.payTo} is not one of our receiving addresses.`),
    () =>
      /^\d+$/.test(requirements.amount) && BigInt(requirements.amount) > 0n
        ? null
        : deny(CHECK.amount, 'Expected amount must be a positive USDC amount in base units.'),
    () =>
      requirements.network === ARC_NETWORK && accepted?.network === ARC_NETWORK && accepted?.scheme === 'exact'
        ? null
        : deny(CHECK.network, `Payment is for ${String(accepted?.scheme)} on ${String(accepted?.network)}; we take exact payments on ${ARC_NETWORK}.`),
    () =>
      sameText(requirements.asset, USDC_ADDRESS) && sameText(accepted?.asset, USDC_ADDRESS)
        ? null
        : deny(CHECK.token, `Payment is in ${String(accepted?.asset)}, not real USDC (${USDC_ADDRESS}). Lookalike tokens do not count.`),
    () => (auth ? null : deny(CHECK.signature, 'Payment carries no EIP-3009 authorization.')),
    () =>
      auth && sameText(auth.to, requirements.payTo) && sameText(accepted?.payTo, requirements.payTo)
        ? null
        : deny(CHECK.recipient, `The authorization does not pay ${requirements.payTo}.`),
    () =>
      auth && auth.value === requirements.amount && accepted?.amount === requirements.amount
        ? null
        : deny(
            CHECK.amount,
            `Authorized ${auth ? formatUsdc(BigInt(auth.value)) : 'nothing'} USDC, expected exactly ${formatUsdc(BigInt(requirements.amount))} USDC.`,
          ),
    () =>
      auth && BigInt(auth.validAfter) < BigInt(facts.now) && BigInt(facts.now) < BigInt(auth.validBefore)
        ? null
        : deny(CHECK.validity, 'The authorization is not valid right now (not yet valid, or expired).'),
    () => (facts.signatureValid ? null : deny(CHECK.signature, `The signature is not ${auth?.from ?? 'the payer'}'s.`)),
    () => (facts.alreadyUsed ? deny(CHECK.replay, 'This authorization was already used to pay for another order.') : null),
  ];
  for (const step of steps) {
    const denial = step();
    if (denial) return denial;
  }
  return allow(`Payment of ${formatUsdc(BigInt(requirements.amount))} USDC checks out; settling it.`);
}
