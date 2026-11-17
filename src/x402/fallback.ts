import { CircleFacilitatorError } from './circle.js';
import type { Facilitator } from './facilitator.js';
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from './protocol.js';

/**
 * Circle's facilitator first; our own once Circle's keyless trial for a payee runs out.
 * Only an exhausted trial switches over. Any other failure is reported as it is, so a
 * rejected payment is never quietly retried somewhere more lenient.
 */
export class FallbackFacilitator implements Facilitator {
  private switched = false;

  constructor(
    private readonly primary: Facilitator,
    private readonly fallback: Facilitator,
    private readonly onSwitch: (reason: string) => void = () => undefined,
  ) {}

  get name(): string {
    return this.switched ? this.fallback.name : this.primary.name;
  }

  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.run((f) => f.verify(payload, requirements));
  }

  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    return this.run((f) => f.settle(payload, requirements));
  }

  private async run<T>(call: (f: Facilitator) => Promise<T>): Promise<T> {
    if (this.switched) return call(this.fallback);
    try {
      return await call(this.primary);
    } catch (err) {
      if (!(err instanceof CircleFacilitatorError && err.trialExhausted)) throw err;
      this.switched = true;
      this.onSwitch(err.message);
      return call(this.fallback);
    }
  }
}
