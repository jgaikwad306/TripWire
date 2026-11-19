import { apiResearchScenario, apiScenarios } from './api.js';
import { approvalScenarios } from './approval.js';
import type { RedTeamScenario } from './helpers.js';
import { honestScenarios } from './honest.js';
import { paidApiScenario } from './paid-api.js';
import { marketScenarios, marketTradeScenario } from './market.js';
import { receiveScenarios } from './receive.js';
import { holdScenarios, quoteScenarios, sendScenarios } from './send.js';

export type { RedTeamOutcome, RedTeamScenario } from './helpers.js';

/** Scenarios 1–15, the paid-API attacks A1–A9, then H1–H5, in the order the report shows them. */
export const ALL_SCENARIOS: readonly RedTeamScenario[] = [
  ...sendScenarios,
  ...approvalScenarios,
  ...holdScenarios,
  ...receiveScenarios,
  ...quoteScenarios,
  ...apiScenarios,
  ...honestScenarios,
  paidApiScenario,
  apiResearchScenario,
  ...marketScenarios,
  marketTradeScenario,
];

/** The paid-API suite: the 9 Gateway nanopayment attacks and the research task that must still work. */
export const API_SUITE: readonly RedTeamScenario[] = [...apiScenarios, apiResearchScenario];

/** The prediction market suite: the 9 Gemini attacks and the honest trade that must still work. */
export const MARKET_SUITE: readonly RedTeamScenario[] = [...marketScenarios, marketTradeScenario];

export const findScenario = (id: string): RedTeamScenario | undefined => ALL_SCENARIOS.find((s) => s.id === id);
