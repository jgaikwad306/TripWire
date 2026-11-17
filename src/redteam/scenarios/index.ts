import { approvalScenarios } from './approval.js';
import type { RedTeamScenario } from './helpers.js';
import { honestScenarios } from './honest.js';
import { paidApiScenario } from './paid-api.js';
import { receiveScenarios } from './receive.js';
import { holdScenarios, sendScenarios } from './send.js';

export type { RedTeamOutcome, RedTeamScenario } from './helpers.js';

/** Scenarios 1–11 then H1–H4, in the order the report shows them. */
export const ALL_SCENARIOS: readonly RedTeamScenario[] = [
  ...sendScenarios,
  ...approvalScenarios,
  ...holdScenarios,
  ...receiveScenarios,
  ...honestScenarios,
  paidApiScenario,
];

export const findScenario = (id: string): RedTeamScenario | undefined => ALL_SCENARIOS.find((s) => s.id === id);
