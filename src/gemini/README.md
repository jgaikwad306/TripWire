# Gemini Prediction Markets: API facts

Step 0 of `docs/GEMINI_MARKETS_PLAN.md`, recorded 2026-11-19. **Verified** means we called the endpoint and checked the response. **Docs** means it is stated on developer.gemini.com but we have not exercised it yet (no Gemini key in this environment). **Unconfirmed** means the docs do not say.

## Public market data (verified, no key)

| What | Call | Notes |
|---|---|---|
| List events | `GET https://api.gemini.com/v1/prediction-markets/events?status=active&limit=50&offset=0` | `{ data: Event[], pagination: { limit, offset, total } }`. About 1,000 active events. 50 events is about 1.8 MB, so fixtures keep only what a run needs. |
| One event | `GET /v1/prediction-markets/events/{ticker}` | Same event shape. No order book. |
| Depth | `GET /v1/book/{instrumentSymbol}?limit_bids=N&limit_asks=N` | YES-space `{ bids, asks: [{ price, amount, timestamp }] }`. Works for `GEMI-…` symbols. |

Event: `ticker`, `title`, `type` (`categorical` / `binary`), `category`, `status`, `expiryDate`, `contracts[]`, plus `volume`, `tags`, `series`… (passthrough).

Contract: `ticker`, `label`, `instrumentSymbol` (e.g. `GEMI-BTC2611192200-HI62750`; use exactly as given), `status`, `marketState` (`open`, `post_only`, …), `expiryDate`, `prices: { bestBid, bestAsk, lastTradePrice, buy: { yes, no }, sell: { yes, no } }`, `priceIncrement` ("0.01"), `quantityIncrement` / `quantityMinimum` ("0.01"), `termsAndConditionsUrl`.

Observed: `prices.buy.no` = 1 − `bestBid` (YES) and `prices.sell.no` = 1 − `bestAsk`. Minutes-long events exist (`BTC05M…`, `BTC15M…`); the demo pick skips anything expiring within 2 hours.

## Sandbox

`https://api.sandbox.gemini.com/v1/prediction-markets/events` **serves events** (verified). Whether a sandbox key can *place* prediction market orders is **unconfirmed**. A sandbox venue reads market data from the sandbox, so the guard checks orders against the books they hit.

## Trading (docs)

- Place order: `POST /v1/prediction-markets/order` with `symbol`, `orderType: limit`, `side`, `quantity`, `price` (0–1), `outcome: yes|no`, `timeInForce` (`good-til-cancel` default, `immediate-or-cancel`, `fill-or-kill`). Response: `orderId` (int64), `status` (`open|filled|cancelled`), `filledQuantity`, `remainingQuantity`, `avgExecutionPrice`, …
- **We place immediate-or-cancel orders**, so nothing rests on the book. The guard still cancels anything a venue reports open after `fillTimeoutMs`.
- Cancel: `POST /v1/prediction-markets/order/cancel` `{ orderId }`. Active: `POST …/orders/active`. History: `POST …/orders/history`. Positions: `POST …/positions`. There is no single-order endpoint; status is looked up in active orders, then history.
- `orderId` is int64. The client quotes it before `JSON.parse` so values above 2^53 stay exact (tested).
- Auth: payload `{ request, nonce, …fields }` base64 in `X-GEMINI-PAYLOAD`, `X-GEMINI-SIGNATURE` = hex HMAC-SHA384 of that base64 string, empty body. Nonce: time-based keys want **epoch seconds within ±30 s**, incremental keys a strictly increasing number (`GEMINI_NONCE_MODE`). Master keys add `account`.
- Terms: the docs name `hasAcceptedLatest`. Paths used: `POST /v1/prediction-markets/terms/status` and `…/terms/accept` (**unconfirmed**: from the plan, not read on the docs site).
- Balance: `POST /v1/balances` (Gemini's standard Get Available Balances), USD.

## Unconfirmed

- Whether a NO order's `price` is the NO price. We assume yes (it matches `prices.buy.no`), and all cost math goes through `costOf()` so it changes in one place.
- Fees, tick size beyond `priceIncrement`, and rate limits. The policy adds `feeBufferBps` (2%).
- Sandbox trading support.

## Live venue decision

Default `GEMINI_ENV=simulated`: real Gemini data, simulated fills. With a Trader-role key (no withdraw), set `GEMINI_ENV=sandbox` and run `npm run cli gemini smoke` to get a real order id. Production needs `GEMINI_ALLOW_PRODUCTION=1` and applies to the guarded pass only. **Unguarded orders only ever reach the simulated venue** (`AllowAllTrader` throws otherwise; tested).
