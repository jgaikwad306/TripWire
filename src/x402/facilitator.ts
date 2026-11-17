import type { FacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from './protocol.js';

/**
 * Verifies and settles x402 payments: checks a signed authorization, then submits it
 * onchain so the USDC actually moves. The merchant never touches the payer's funds itself.
 */
export interface Facilitator {
  /** Shown in reports, e.g. "circle" or "local". */
  readonly name: string;
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

/**
 * A facilitator run in this process, using the official x402 implementation of the exact
 * EVM scheme. What it settles through is the signer: the fake ledger offline, or a
 * wallet that pays the gas on Arc.
 */
export class LocalFacilitator implements Facilitator {
  readonly name = 'local';
  private readonly scheme: ExactEvmScheme;

  constructor(signer: FacilitatorEvmSigner) {
    this.scheme = new ExactEvmScheme(signer);
  }

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.scheme.verify(payload, requirements);
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.scheme.settle(payload, requirements);
  }
}
