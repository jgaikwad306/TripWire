import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, FakeLedger } from '../../src/fakes/index.js';
import { LocalFacilitator } from '../../src/x402/facilitator.js';
import { exactRequirements, nonceFor, signPayment } from '../../src/x402/protocol.js';

const PRICE = parseUsdc('0.5');
const inAMinute = () => Math.floor(Date.now() / 1000) + 60;

async function setup() {
  const ledger = new FakeLedger({ hot: parseUsdc('10') });
  const facilitator = new LocalFacilitator(ledger.facilitatorSigner());
  const requirements = exactRequirements(FAKE_ADDRESSES.merchant, PRICE);
  const pay = (overrides: Partial<Parameters<typeof signPayment>[0]> = {}) =>
    signPayment({
      sign: (data) => ledger.signTypedData('hot', data),
      from: FAKE_ADDRESSES.hot,
      requirements,
      nonce: nonceFor('payment-1'),
      validBefore: inAMinute(),
      ...overrides,
    });
  return { ledger, facilitator, requirements, pay };
}

describe('official x402 facilitator over the fake ledger', () => {
  it('verifies and settles a signed exact payment, moving the USDC', async () => {
    const { ledger, facilitator, requirements, pay } = await setup();
    const payload = await pay();

    expect(await facilitator.verify(payload, requirements)).toMatchObject({ isValid: true });
    const settled = await facilitator.settle(payload, requirements);

    expect(settled).toMatchObject({ success: true });
    expect(await ledger.getUsdcBalance(FAKE_ADDRESSES.merchant)).toBe(PRICE);
    const tx = await ledger.getTx(settled.transaction as `0x${string}`);
    expect(tx?.transfers).toEqual([expect.objectContaining({ to: FAKE_ADDRESSES.merchant, value: PRICE })]);
    expect(await ledger.authorizationUsed(FAKE_ADDRESSES.hot, nonceFor('payment-1'))).toEqual({
      used: true,
      txHash: settled.transaction,
    });
  });

  it('settles a nonce only once', async () => {
    const { facilitator, requirements, pay } = await setup();
    const payload = await pay();
    await facilitator.settle(payload, requirements);
    const again = await facilitator.settle(payload, requirements);
    expect(again.success).toBe(false);
  });

  it('rejects a payment signed by someone other than the payer', async () => {
    const { ledger, facilitator, requirements, pay } = await setup();
    const forged = await pay({ sign: (data) => ledger.signTypedData('attacker', data) });
    expect(await facilitator.verify(forged, requirements)).toMatchObject({ isValid: false });
  });

  it('rejects a payment for less than the price', async () => {
    const { facilitator, requirements, pay } = await setup();
    const under = await pay({ value: PRICE / 2n });
    expect(await facilitator.verify(under, requirements)).toMatchObject({ isValid: false });
  });
});
