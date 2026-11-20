# Live Gemini order through the market guard (sandbox)

`npm run cli gemini smoke` with `GEMINI_ENV=sandbox`, 2026-11-19T03:42:54Z.

| | |
|---|---|
| Venue | Gemini sandbox (`api.sandbox.gemini.com`), account-scoped API key, Trader role |
| Market | BTC price on November 19 · $63,000 or above (`GEMI-BTC2611192200-HI63000`) |
| Order | buy 1 YES, limit 0.40, immediate-or-cancel |
| Guard | allowed: all 11 market checks passed, terms accepted (`hasAcceptedLatest: true`) |
| Gemini order id | **145853902322749038** |
| Result | filled 1 at 0.40 |
| Afterwards | position 1 YES on `GEMI-BTC2611192200-HI63000`; USD 100000.00 → 99999.58 (0.40 + 0.02 fee) |

Audit log line (`results/markets/audit.jsonl`, not committed):

```json
{"at":"2026-11-19T03:42:54.942Z","guard":"on","kind":"market","resource":"GEMI-BTC2611192200-HI63000","amountUsdc":"1 @ 0.4","allowed":true,"rule":"ok","reason":"All market checks passed. Gemini order 145853902322749038: buy 1 YES at ≤ 0.4, filled 1 at 0.4.","orderRef":"145853902322749038"}
```

The order id is above 2^53; the client keeps int64 ids as strings so it is exact.
