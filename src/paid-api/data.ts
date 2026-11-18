/**
 * What the paid API sells. The figures are realistic but generated locally, so a demo
 * never depends on a third-party feed; every response says so in `source`. The payment
 * for them is real.
 */
const SOURCE = 'tripwire demo feed (generated, not live market data)';

const REFERENCE: Record<string, { price: number; volume: number }> = {
  BTC: { price: 97_250, volume: 31_400_000_000 },
  ETH: { price: 3_420, volume: 14_900_000_000 },
  SOL: { price: 182.4, volume: 3_100_000_000 },
  USDC: { price: 1, volume: 6_800_000_000 },
  AVAX: { price: 38.1, volume: 520_000_000 },
  LINK: { price: 17.9, volume: 610_000_000 },
};

/** A small deterministic wobble so repeated calls in a minute agree and calls an hour apart differ. */
function wobble(seed: string, spread: number): number {
  let h = 0;
  for (const c of `${seed}:${Math.floor(Date.now() / 3_600_000)}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ((h % 2000) / 1000 - 1) * spread;
}

export function marketData(rawSymbol: string): Record<string, unknown> {
  const symbol = rawSymbol.trim().toUpperCase().slice(0, 10) || 'BTC';
  const ref = REFERENCE[symbol] ?? { price: 10 + (symbol.charCodeAt(0) % 40), volume: 90_000_000 };
  const change = wobble(symbol, 4);
  return {
    symbol,
    price_usd: Number((ref.price * (1 + wobble(`${symbol}:p`, 0.01))).toFixed(ref.price < 10 ? 4 : 2)),
    change_24h_pct: Number(change.toFixed(2)),
    volume_24h_usd: Math.round(ref.volume * (1 + wobble(`${symbol}:v`, 0.1))),
    as_of: new Date().toISOString(),
    source: SOURCE,
  };
}

const HEADLINES: Record<string, [string, number][]> = {
  crypto: [
    ['Stablecoin settlement volumes hit a record as payment firms move onchain', 0.62],
    ['Regulators publish final guidance on reserve audits for dollar stablecoins', 0.35],
    ['Exchange outage delays withdrawals for three hours', -0.48],
    ['Agentic payment pilots expand to sub-cent API billing', 0.55],
  ],
  ai: [
    ['Inference prices fall again as new accelerators ship', 0.4],
    ['Security researchers show prompt injection draining agent wallets', -0.7],
    ['Enterprises adopt spending policies for autonomous agents', 0.45],
  ],
};

export function newsSentiment(rawTopic: string): Record<string, unknown> {
  const topic = rawTopic.trim().toLowerCase().slice(0, 40) || 'crypto';
  const items = HEADLINES[topic] ?? HEADLINES.crypto!;
  const score = items.reduce((sum, [, s]) => sum + s, 0) / items.length;
  return {
    topic,
    sentiment: score > 0.15 ? 'positive' : score < -0.15 ? 'negative' : 'neutral',
    score: Number(score.toFixed(2)),
    headlines: items.map(([title, s]) => ({ title, score: s })),
    as_of: new Date().toISOString(),
    source: SOURCE,
  };
}

/** A real (if small) compute job: word statistics and the most frequent terms of the prompt. */
export function analyse(prompt: string): Record<string, unknown> {
  const words = prompt.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) if (w.length > 3) counts.set(w, (counts.get(w) ?? 0) + 1);
  return {
    words: words.length,
    characters: prompt.length,
    top_terms: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([term, n]) => ({ term, n })),
    source: 'tripwire compute job',
  };
}
