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

`https://api.sandbox.gemini.com/v1/prediction-markets/events` **serves events**, and a sandbox account-scoped Trader key **can place prediction market orders** (verified 2026-11-19: order `145853902322749038`, see `results/markets/gemini-sandbox-order.md`). The sandbox account came with 100,000 test USD and the terms already accepted. A sandbox venue reads market data from the sandbox, so the guard checks orders against the books they hit.

## Trading (docs)

- Place order: `POST /v1/prediction-markets/order` with `symbol`, `orderType: limit`, `side`, `quantity`, `price` (0–1), `outcome: yes|no`, `timeInForce` (`good-til-cancel` default, `immediate-or-cancel`, `fill-or-kill`). Response: `orderId` (int64), `status` (`open|filled|cancelled`), `filledQuantity`, `remainingQuantity`, `avgExecutionPrice`, …
- **We place immediate-or-cancel orders**, so nothing rests on the book. The guard still cancels anything a venue reports open after `fillTimeoutMs`.
- Cancel: `POST /v1/prediction-markets/order/cancel` `{ orderId }`. Active: `POST …/orders/active`. History: `POST …/orders/history`. Positions: `POST …/positions`. There is no single-order endpoint; status is looked up in active orders, then history.
- `orderId` is int64. The client quotes it before `JSON.parse` so values above 2^53 stay exact (tested).
- Auth (verified on the sandbox): payload `{ request, nonce, …fields }` base64 in `X-GEMINI-PAYLOAD`, `X-GEMINI-SIGNATURE` = hex HMAC-SHA384 of that base64 string, empty body. Nonce: epoch seconds by default, and **strictly increasing even for time-based keys** (a repeated second is refused with `InvalidNonce: … has not increased`), so a second call in the same second uses the next second. Master keys add `account`.
- Terms (verified): **Get Terms Status is a signed `GET /v1/prediction-markets/terms/status`** (a POST gets `405 VerbNotSupported`) returning `{ hasAcceptedLatest, acceptedVersion, latestVersion }`. Accept is a signed `POST /v1/prediction-markets/terms/accept` → `{ success }`. The terms text is public: `GET /v1/prediction-markets/terms`.
- Balance (verified): `POST /v1/balances`, USD `available`.
- Fee (observed once): 0.02 on a 1-contract buy at 0.40 (5%). The policy's `feeBufferBps` is 500 to match.

## Unconfirmed

- Whether a NO order's `price` is the NO price. We assume yes (it matches `prices.buy.no`), and all cost math goes through `costOf()` so it changes in one place.
- The fee schedule (one observation above), tick size beyond `priceIncrement`, and rate limits.

## Live venue decision

Default `GEMINI_ENV=simulated`: real Gemini data, simulated fills. With a Trader-role key (no withdraw), set `GEMINI_ENV=sandbox` and run `npm run cli gemini smoke` to get a real order id. Production needs `GEMINI_ALLOW_PRODUCTION=1` and applies to the guarded pass only. **Unguarded orders only ever reach the simulated venue** (`AllowAllTrader` throws otherwise; tested).
