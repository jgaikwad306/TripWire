import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, createFakeContext } from '../../src/fakes/index.js';
import { LocalFacilitator } from '../../src/x402/facilitator.js';
import { MAX_TIMEOUT_SECONDS, nonceFor, signPayment, type PaymentRequirements } from '../../src/x402/protocol.js';
import { createGuard } from '../../src/guard/index.js';
import { defaultPolicy, type Policy } from '../../src/guard/policy.js';
import type { Address, PaymentIntent, WalletProvider } from '../../src/types.js';

export const MERCHANT = FAKE_ADDRESSES.merchant;
export const ATTACKER = FAKE_ADDRESSES.attacker;
/** Someone paying us, with a real key so they can sign x402 payments. */
export const customer = privateKeyToAccount(keccak256(toHex('tripwire-test-customer')));
export const CUSTOMER: Address = customer.address.toLowerCase() as Address;

let paymentSeq = 0;

/** The customer's signed x402 payment for these terms. Overrides model attacks. */
export function customerPayment(
  requirements: PaymentRequirements,
  overrides: Partial<Parameters<typeof signPayment>[0]> = {},
) {
  return signPayment({
    sign: (data) => customer.signTypedData(data as Parameters<typeof customer.signTypedData>[0]),
    from: CUSTOMER,
    requirements,
    nonce: nonceFor(`customer-payment-${++paymentSeq}`),
    validBefore: Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS,
    ...overrides,
  });
}

const addressBook: Pick<WalletProvider, 'addressOf'> = { addressOf: (role) => FAKE_ADDRESSES[role] };

/** Default policy for the fake world, with optional overrides. */
export const policyWith = (overrides: Partial<Policy> = {}): Policy => defaultPolicy(addressBook, overrides);

export const intentWith = (overrides: Partial<PaymentIntent> = {}): PaymentIntent => ({
  id: 'intent-1',
  merchantUrl: 'fake://merchant',
  item: 'report',
  payTo: MERCHANT,
  amount: parseUsdc('0.5'),
  createdAt: 0,
  status: 'open',
  ...overrides,
});

/** The fake world with the real guard dropped in. */
export function guardedWorld(overrides: Partial<Policy> = {}, now?: () => number) {
  return createFakeContext((ledger, merchant) =>
    createGuard({
      wallet: ledger,
      chain: ledger,
      fetchQuote: merchant.fetchQuote,
      fetchImpl: merchant.fetch,
      facilitator: new LocalFacilitator(ledger.facilitatorSigner()),
      policy: defaultPolicy(ledger, overrides),
      ...(now ? { now } : {}),
    }),
  );
}
