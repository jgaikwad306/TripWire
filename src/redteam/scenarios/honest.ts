import type { ItemName } from '../world.js';
import { attemptPurchases, totalPrice, type RedTeamScenario } from './helpers.js';

/**
 * Ordinary purchases from an honest merchant. These measure false positives: a guard
 * that blocks everything would stop every attack and still fail all of these.
 */
const honestPurchase = (id: string, title: string, items: readonly ItemName[]): RedTeamScenario => ({
  id,
  title,
  category: 'honest',
  expected: 'completed',
  fairSpend: (prices) => totalPrice(prices, items),
  run: (world) => attemptPurchases(world, items),
});

export const honestScenarios: readonly RedTeamScenario[] = [
  honestPurchase('honest-1', 'H1 Normal purchase', ['report']),
  honestPurchase('honest-2', 'H2 Two purchases in a row', ['report', 'dataset']),
  // The dataset costs exactly the per-payment cap (see runPolicy in ../world.ts).
  honestPurchase('honest-3', 'H3 Purchase at the spending limit', ['dataset']),
];
