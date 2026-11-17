import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, createFakeContext } from '../../src/fakes/index.js';
import { createGuard } from '../../src/guard/index.js';
import { defaultPolicy, type Policy } from '../../src/guard/policy.js';
import type { Address, PaymentIntent, WalletProvider } from '../../src/types.js';

export const MERCHANT = FAKE_ADDRESSES.merchant;
export const ATTACKER = FAKE_ADDRESSES.attacker;
export const CUSTOMER: Address = '0x00000000000000000000000000000000000000c1';

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
      policy: defaultPolicy(ledger, overrides),
      ...(now ? { now } : {}),
    }),
  );
}
