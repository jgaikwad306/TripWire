import { BatchEvmScheme } from '@circle-fin/x402-batching/client';
import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, FakeLedger } from '../../src/fakes/index.js';
import type { TypedDataRequest } from '../../src/types.js';
import { FakeGateway, GATEWAY_VALIDITY_SECONDS, GATEWAY_WALLET, gatewayRequirements, isArcGatewayOption } from '../../src/x402/gateway.js';
import { authorizationTypedData, eip3009Of, nonceFor, signPayment } from '../../src/x402/protocol.js';

const PRICE = parseUsdc('0.001');
const now = () => Math.floor(Date.now() / 1000);

describe('Circle Gateway nanopayments', () => {
  it("signs exactly the EIP-712 message Circle's own BatchEvmScheme signs", async () => {
    const requirements = gatewayRequirements(FAKE_ADDRESSES.merchant, PRICE);
    let sdkTyped: TypedDataRequest | undefined;
    const sdk = new BatchEvmScheme({
      address: FAKE_ADDRESSES.hot,
      signTypedData: async (data: unknown) => {
        sdkTyped = data as TypedDataRequest;
        return `0x${'11'.repeat(65)}`;
      },
    } as never);
    const sdkPayload = await sdk.createPaymentPayload(2, requirements as never);
    const auth = eip3009Of(sdkPayload as never)!.authorization;

    const ours = authorizationTypedData(requirements, auth);
    expect(ours.domain).toEqual(sdkTyped!.domain);
    expect(ours.message).toEqual(sdkTyped!.message);
    expect(ours.primaryType).toBe(sdkTyped!.primaryType);
    expect(ours.types.TransferWithAuthorization).toEqual(sdkTyped!.types.TransferWithAuthorization);
    expect(ours.domain).toMatchObject({ name: 'GatewayWalletBatched', version: '1', chainId: 5042002 });
    expect(String(ours.domain.verifyingContract).toLowerCase()).toBe(GATEWAY_WALLET);
  });

  it('settles offline like Gateway: balance moves, the nonce is spent, the record is kept', async () => {
    const ledger = new FakeLedger();
    const gateway = new FakeGateway();
    gateway.deposit(FAKE_ADDRESSES.hot, parseUsdc('1'));
    const requirements = gatewayRequirements(FAKE_ADDRESSES.merchant, PRICE);
    expect(isArcGatewayOption(requirements)).toBe(true);
    const nonce = nonceFor('gw-1');
    const payload = await signPayment({
      sign: (d) => ledger.signTypedData('hot', d),
      from: FAKE_ADDRESSES.hot,
      requirements,
      nonce,
      validBefore: now() + GATEWAY_VALIDITY_SECONDS,
    });

    expect(await gateway.verify(payload, requirements)).toMatchObject({ isValid: true });
    const settled = await gateway.settle(payload, requirements);
    expect(settled.success).toBe(true);
    expect(await gateway.balance(FAKE_ADDRESSES.merchant)).toBe(PRICE);
    expect(await gateway.balance(FAKE_ADDRESSES.hot)).toBe(parseUsdc('1') - PRICE);
    expect(await gateway.transferByNonce(FAKE_ADDRESSES.hot, nonce)).toMatchObject({ id: settled.transaction, amount: PRICE });
    expect(await gateway.settle(payload, requirements)).toMatchObject({ success: false, errorReason: 'nonce_already_used' });
  });

  it('rejects what Gateway rejects', async () => {
    const ledger = new FakeLedger();
    const gateway = new FakeGateway();
    gateway.deposit(FAKE_ADDRESSES.hot, PRICE);
    const requirements = gatewayRequirements(FAKE_ADDRESSES.merchant, PRICE);
    const sign = (overrides: Partial<Parameters<typeof signPayment>[0]>) =>
      signPayment({ sign: (d) => ledger.signTypedData('hot', d), from: FAKE_ADDRESSES.hot, requirements, nonce: nonceFor(String(Math.random())), validBefore: now() + GATEWAY_VALIDITY_SECONDS, ...overrides });

    const short = await sign({ validBefore: now() + 120 });
    expect(await gateway.verify(short, requirements)).toMatchObject({ invalidReason: 'authorization_validity_too_short' });
    const forged = await sign({ sign: (d) => ledger.signTypedData('attacker', d) });
    expect(await gateway.verify(forged, requirements)).toMatchObject({ invalidReason: 'invalid_signature' });
    const tooMuch = await sign({ requirements: gatewayRequirements(FAKE_ADDRESSES.merchant, PRICE * 2n) });
    expect(await gateway.verify(tooMuch, gatewayRequirements(FAKE_ADDRESSES.merchant, PRICE * 2n))).toMatchObject({ invalidReason: 'insufficient_balance' });
  });
});
