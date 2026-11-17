import { recoverTypedDataAddress, keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import { FAKE_ADDRESSES, FakeLedger } from '../../src/fakes/index.js';
import type { Address, TypedDataRequest } from '../../src/types.js';
import { CircleFacilitator, CircleFacilitatorError, sellerRequestTypedData } from '../../src/x402/circle.js';
import type { Facilitator } from '../../src/x402/facilitator.js';
import { FallbackFacilitator } from '../../src/x402/fallback.js';
import { ARC_NETWORK, MAX_TIMEOUT_SECONDS, exactRequirements, nonceFor, signPayment } from '../../src/x402/protocol.js';

const ledger = new FakeLedger();
const requirements = exactRequirements(FAKE_ADDRESSES.merchant, parseUsdc('1'));
const payload = () =>
  signPayment({
    sign: (data) => ledger.signTypedData('hot', data),
    from: FAKE_ADDRESSES.hot,
    requirements,
    nonce: nonceFor('circle-test'),
    validBefore: Math.floor(Date.now() / 1000) + MAX_TIMEOUT_SECONDS,
  });
const sellerSigner = (payTo: Address, data: TypedDataRequest) =>
  ledger.signTypedData(payTo === FAKE_ADDRESSES.merchant ? 'merchant' : 'attacker', data);

interface Call {
  url: string;
  method: string;
  body: string;
  proof: Record<string, unknown>;
}

function circle(answers: ((call: Call) => { status: number; body: unknown })[]) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const header = new Headers(init?.headers).get('Facilitator-Seller-Proof')!;
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : '',
      proof: JSON.parse(Buffer.from(header, 'base64url').toString()),
    };
    calls.push(call);
    const { status, body } = answers[Math.min(calls.length - 1, answers.length - 1)]!(call);
    return new Response(JSON.stringify(body), { status });
  };
  return { facilitator: new CircleFacilitator(sellerSigner, { fetchImpl }), calls };
}

describe("Circle's facilitator", () => {
  it('sends the x402 body with a seller proof the payee signed over that exact body', async () => {
    const { facilitator, calls } = circle([() => ({ status: 200, body: { isValid: true, payer: FAKE_ADDRESSES.hot } })]);
    const p = await payload();

    expect(await facilitator.verify(p, requirements)).toMatchObject({ isValid: true });

    const [call] = calls;
    expect(call!.url).toBe('https://api.circle.com/v1/facilitator/x402/verify');
    expect(JSON.parse(call!.body)).toEqual({ x402Version: 2, paymentPayload: p, paymentRequirements: requirements });
    const proof = call!.proof as { signature: `0x${string}`; nonce: `0x${string}`; issuedAt: number; expiresAt: number; network: string };
    expect(proof).toMatchObject({ version: 1, network: ARC_NETWORK, payTo: requirements.payTo });
    expect(proof.expiresAt - proof.issuedAt).toBeLessThanOrEqual(300);
    const signer = await recoverTypedDataAddress({
      ...(sellerRequestTypedData({
        chainId: 5042002,
        purpose: 'verify',
        method: 'POST',
        bodyHash: keccak256(toBytes(call!.body)),
        network: ARC_NETWORK,
        payTo: FAKE_ADDRESSES.merchant,
        nonce: proof.nonce,
        issuedAt: proof.issuedAt,
        expiresAt: proof.expiresAt,
      }) as Parameters<typeof recoverTypedDataAddress>[0]),
      signature: proof.signature,
    });
    expect(signer.toLowerCase()).toBe(FAKE_ADDRESSES.merchant);
  });

  it('waits out a pending settlement through the status endpoint', async () => {
    const tx = `0x${'cd'.repeat(32)}`;
    const { facilitator, calls } = circle([
      () => ({
        status: 200,
        body: {
          success: false,
          errorReason: 'settlement_pending',
          transaction: '',
          network: ARC_NETWORK,
          extensions: { 'settlement-status': { paymentId: 'pay-1', statusUrl: '/status/pay-1' } },
        },
      }),
      () => ({ status: 200, body: { paymentId: 'pay-1', status: 'completed', transaction: tx, payer: FAKE_ADDRESSES.hot } }),
    ]);

    expect(await facilitator.settle(await payload(), requirements)).toMatchObject({ success: true, transaction: tx });
    expect(calls[1]).toMatchObject({ url: 'https://api.circle.com/v1/facilitator/x402/status/pay-1', method: 'GET', body: '' });
    expect(calls[1]!.proof).toMatchObject({ payTo: requirements.payTo });
  });

  it('reports an exhausted keyless trial as such', async () => {
    const { facilitator } = circle([
      () => ({ status: 403, body: { code: 403, message: 'Trial used up.', errors: [{ reason: 'registration_required' }] } }),
    ]);
    const err = await facilitator.settle(await payload(), requirements).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CircleFacilitatorError);
    expect((err as CircleFacilitatorError).trialExhausted).toBe(true);
  });
});

describe('falling back from Circle to our own facilitator', () => {
  const local: Facilitator = {
    name: 'local',
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: true, transaction: '0xlocal', network: ARC_NETWORK }),
  };

  it('switches only when the trial is exhausted, and stays switched', async () => {
    const switches: string[] = [];
    const exhausted: Facilitator = {
      name: 'circle',
      verify: async () => Promise.reject(new CircleFacilitatorError(403, ['registration_required'], 'Trial used up.')),
      settle: async () => Promise.reject(new Error('unreachable')),
    };
    const facilitator = new FallbackFacilitator(exhausted, local, (reason) => switches.push(reason));

    expect(await facilitator.verify(await payload(), requirements)).toMatchObject({ isValid: true });
    expect(await facilitator.settle(await payload(), requirements)).toMatchObject({ transaction: '0xlocal' });
    expect(facilitator.name).toBe('local');
    expect(switches).toHaveLength(1);
  });

  it('never retries a rejection somewhere more lenient', async () => {
    const strict: Facilitator = {
      name: 'circle',
      verify: async () => Promise.reject(new CircleFacilitatorError(401, [], 'Bad seller proof.')),
      settle: async () => ({ success: false, errorReason: 'invalid_exact_evm_payload_signature', transaction: '', network: ARC_NETWORK }),
    };
    const facilitator = new FallbackFacilitator(strict, local);

    await expect(facilitator.verify(await payload(), requirements)).rejects.toThrow(/Bad seller proof/);
    expect(await facilitator.settle(await payload(), requirements)).toMatchObject({ success: false });
    expect(facilitator.name).toBe('circle');
  });
});
