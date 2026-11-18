import { parseUsdc } from '../constants.js';
import { LocalFacilitator } from '../x402/facilitator.js';
import type { AgentTools, Guard, ScenarioContext } from '../types.js';
import { ScriptedAgent } from './agent.js';
import { AllowAllGuard } from './guard.js';
import { FAKE_ADDRESSES, FakeLedger } from './ledger.js';
import { FakeMerchant } from './merchant.js';

export { ScriptedAgent } from './agent.js';
export { AllowAllGuard } from './guard.js';
export { FAKE_ADDRESSES, FAKE_TOKEN_ADDRESS, FakeLedger } from './ledger.js';
export { FakeMerchant } from './merchant.js';

/** The tools an agent sees, routed through a guard. */
export function toolsFor(guard: Guard): AgentTools {
  return {
    getQuote: (merchantUrl, item, order) => guard.getQuote(merchantUrl, item, order),
    requestPayment: (req) => guard.requestPayment(req),
    buyResource: (req) => guard.fetchPaid(req),
    checkBalance: () => guard.hotBalance(),
  };
}

/**
 * A complete offline world: funded ledger, merchant, naive agent, allow-all guard.
 * Pass `makeGuard` to drop in the real guard and keep everything else fake.
 */
export function createFakeContext(
  makeGuard?: (ledger: FakeLedger, merchant: FakeMerchant) => Guard,
): ScenarioContext & { ledger: FakeLedger; merchant: FakeMerchant } {
  const ledger = new FakeLedger({ vault: parseUsdc('100'), hot: parseUsdc('10') });
  const merchant = new FakeMerchant({
    payTo: FAKE_ADDRESSES.merchant,
    attacker: FAKE_ADDRESSES.attacker,
    prices: { report: parseUsdc('0.5'), dataset: parseUsdc('2') },
    facilitator: new LocalFacilitator(ledger.facilitatorSigner()),
  });
  const guard = makeGuard
    ? makeGuard(ledger, merchant)
    : new AllowAllGuard(ledger, merchant.fetchQuote, { chain: ledger, fetchImpl: merchant.fetch });
  return {
    ledger,
    wallet: ledger,
    chain: ledger,
    guard,
    agent: new ScriptedAgent(),
    tools: toolsFor(guard),
    merchant,
    attacker: FAKE_ADDRESSES.attacker,
  };
}
