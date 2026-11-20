# TripWire handoff

Status as of 2026-11-19. For whoever picks the project up next. The README has the full reference; this is the map, the current state, and what's left.

## What changed since the last handoff (2026-11-18)

- **The Gateway work is on `main`.** All of `feat/gateway-nanopayments` was merged, plus UI work: "How the guard works" tab (#25, #26), hero and background art (#24), dashboard fixes (#23).
- **Gemini Prediction Markets shipped** (#27, merged): a second guard for prediction-market orders, nine market attacks, a dashboard tab, and **a real Gemini order placed through the guard** on the Gemini sandbox. See [Gemini Prediction Markets](#gemini-prediction-markets).
- **README reorganised** (#28): team-process notes removed, sections regrouped by feature.
- **Fixed:** offline market runs no longer clobber the live evidence; they write to `results/markets/`. `results/redteam.{json,md}` is still overwritten by other `--compare` runs (see Gotchas).
- **Bring-your-own-agent** (`feat/byo-agent`) is unchanged since its WIP commit; a teammate owns it.

## What TripWire is

A guarded USDC wallet for AI agents on **Circle Arc**, plus a **red team** that attacks the agent and scores how safe it is. The agent (an LLM) never holds a key: it asks the guard to pay, and the guard checks every hold, send, receive and paid API call before it signs anything. Every attack runs twice, guard on and guard off, so the report shows exactly what the guard saved.

Since #27 the same idea covers **trading**: the agent buys market intel in USDC on Arc, then trades Gemini prediction markets, and a **market guard** decides every order.

Built for the UBC 2026 hackathon, Track 1: Agentic Payments & AI (plus the Best use of Arc award). The Gemini Prediction Markets bounty is entered on top of it. Plans: `docs/JUDGE_FEEDBACK_PLAN.md` (Track 1) and `docs/GEMINI_MARKETS_PLAN.md` (Gemini bounty).

### Headline results

| | Guard on | Guard off | Where |
|---|---|---|---|
| Paid-API attacks blocked (live Arc Testnet, real Gateway nanopayments) | 9 / 9 | 0 / 9 | `results/redteam.md` |
| USDC lost | 0 | 3.038 | |
| Prediction-market attacks blocked (offline, real Gemini snapshot) | 9 / 9 | 0 / 9 | README, Gemini section |
| USD at risk on Gemini | 0 | 303.55 | |
| Honest tasks completed | yes | yes | |

**Live Gemini evidence:** order **145853902322749038** on the Gemini sandbox: 1 YES of "BTC price on November 19 · $63,000 or above" at 0.40, filled after every market check. Details in `results/markets/gemini-sandbox-order.md`.

## Branches

| Branch | State |
|---|---|
| `main` | **The current app.** Everything above is merged. Start here. |
| `feat/byo-agent` | WIP bring-your-own-agent (see Open work). Built on the pre-merge Gateway branch, so it needs a rebase onto `main`; expect a conflict in `src/agent/tools.ts`. A teammate owns it. |
| `docs/handoff` | This file. Not merged into `main` yet. |
| `feat/gateway-nanopayments`, `feat/gemini-markets` | Merged. Safe to delete. |

## Architecture

Everything runs locally as one Node/TypeScript process. There is no hosted backend and no database: state is JSON files on disk. That's deliberate: the process holds wallet and Gemini keys from `.env`, so servers bind to `127.0.0.1` behind a session token, and runs share real wallets, so only one runs at a time.

```
LLM agent ──tool calls──▶ Guard ──signs only if every check passes──▶ x402 payment ──▶ Arc Testnet (USDC)
 (src/agent)  │            (src/guard)          Mock merchant · Paid API · Circle facilitator / Gateway
              │
              └─place_prediction_order──▶ Market guard ──only if every check passes──▶ Gemini venue
                                          (src/guard/market*.ts)     simulated | sandbox | production
```

| Folder | What lives there |
|---|---|
| `src/types.ts` | The shared contracts every part compiles against. Change with care. |
| `src/guard/` | Policy, intents, send/receive/API checks, hold (hot/vault sweep), approvals, persisted state, audit log. **`market.ts`** (pure market checks) and **`market-guard.ts`** (`GuardedTrader`, the unguarded `AllowAllTrader`) |
| `src/gemini/` | Gemini client (signed REST, int64 order ids kept exact), market snapshot and demo-market picker, demo policy, `gemini` CLI commands, smoke order. **`src/gemini/README.md`** records the verified API facts |
| `src/agent/` | Grok tool-use loop (any OpenAI-compatible API), tool definitions (market tools appear only when an agent can trade) |
| `src/merchant/`, `src/paid-api/` | The shop and the paid x402 data API, each with attack modes. The paid API also sells `/premium/market-intel`, the market attacks' carrier |
| `src/wallet/`, `src/chain/` | Circle developer-controlled wallets, Gateway, Arc chain reader, refund, counterfeit token |
| `src/x402/` | Protocol helpers on the official `@x402` packages; Circle facilitator, local facilitator, fallback, Gateway client |
| `src/redteam/` | Scenarios, runner, scoring, the scripted (naive) agent, CLI commands. Market side: `market-intel.ts`, `market-agent.ts`, `market-world.ts`, `market-loss.ts`, `scenarios/market.ts` |
| `src/report/` | JSON / Markdown / HTML / terminal reports, `results/redteam.{json,md}` |
| `src/dashboard/` | The live attack lab: local HTTP server, event stream, browser client, run recordings. Tabs: Attack lab, How the guard works, **Prediction markets** (`markets.ts` serves the odds board) |
| `src/owner/` | Local page where the owner approves large payments |
| `src/streams/` | Optional QuickNode Streams monitoring of wallet outflows |
| `src/fakes/` | In-memory ledger, guard, merchant, and **`gemini-venue.ts`** (simulated exchange): everything in `test/` runs offline on these |
| `fixtures/gemini/` | Snapshot of real Gemini events and order books for offline runs |

### Scenarios (33 attacks, 6 honest controls)

- **9 paid-API attacks** (Gateway nanopayments): prompt injection in paid data, payee swap, 1000x price inflation, drain loop, salami slicing, wrong network, redirect to unapproved domain, duplicate charge, off-task purchase.
- **9 prediction-market attacks** (M1–M9, Gemini): injection into an unrelated market, contract swap, price sweep, outcome flip, size inflation, refill loop, salami across strikes, fake halt, last-second contract. Each is built to trip its own market check, and the mutation test checks that switching that check off makes the attack succeed.
- **Send, receive and hold attacks** on the merchant flow (swapped payTo, inflated price, prompt injection, payment loop, fake owner, move-to-safety, forged/counterfeit/replayed payments, self-approval, …).
- **Honest controls** (H1–H6): purchases and the honest Gemini trade (H6) that must still succeed with the guard on.

The full catalog with descriptions is in `src/dashboard/catalog.ts`; the dashboard's **Configure** shows all of them.

## Gemini Prediction Markets

How it works, in short (full detail in the README's Gemini section):

- **Market guard:** it alone holds the Gemini key. For every order it reads the event and order book from Gemini itself, so agent prices and symbols are never trusted. Checks run in order: `market`, `market-state`, `side`, `outcome`, `price`, `slippage`, `limits`, `budget`, `rate-limit`, `duplicate`, then terms/venue.
- **Orders** are immediate-or-cancel, recorded as pending before they are sent, and audited (`kind: "market"`).
- **Unguarded orders only ever reach the simulated venue**, an in-memory exchange seeded from real Gemini books. `AllowAllTrader` throws on any other venue.
- **Loss is "USD at risk"**, computed from fills and never added to USDC totals.

Facts learned on the live sandbox (also in `src/gemini/README.md`):

- **Get Terms Status is a signed GET**, not a POST.
- **Nonces must strictly increase, even for time-based keys.** The client uses epoch seconds and bumps to the next second when needed.
- **Gemini charged a 5% fee** (0.02 on 0.40), so the market policy's fee buffer is 500 bps.
- **The sandbox supports prediction-market trading**: an account-scoped Trader key, 100,000 test USD, and terms already accepted.

Still unconfirmed: whether a NO order's price is in NO space (assumed; all cost math goes through `costOf()`), the full fee schedule, and rate limits.

## Running it

```bash
npm install
cp .env.example .env
```

| Goal | Command |
|---|---|
| Visual demo, offline, no keys | `npm run dashboard -- --fake --agent naive` (try the **Prediction markets** tab) |
| Visual demo, live (Arc Testnet + Grok) | `npm run dashboard` |
| Replay a recorded run, offline | `npm run demo:replay` · markets: `npm run demo:replay -- recordings/markets.journal.json` |
| Paid-API attacks in the terminal, offline | `npm run redteam:api -- --fake --results-dir reports/offline` |
| Prediction-market attacks, offline | `npm run redteam:market -- --fake` (writes `results/markets/`) |
| Same, live | `npm run redteam:api` · `npm run redteam:market` |
| All attacks | `npm run redteam` (add `--fake --results-dir reports/offline` offline) |
| One paid purchase end to end | `npm run buy` |
| Gemini: live events / sandbox account / one guarded order | `npm run cli gemini markets --search btc` · `gemini status` · `gemini smoke` |
| Refresh the Gemini snapshot | `npm run cli gemini snapshot` (before recording a demo: tickers expire) |
| Tests (offline) / types | `npm test` / `npm run typecheck` |
| Read-only checks against real Arc | `LIVE=1 npm test` |

Dashboard: open the printed URL (it contains a private token), click **Run comparison**, or on the Prediction markets tab **Focused: trade + 3 attacks**.

### Live setup

Fill `.env` (template: `.env.example`): `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, wallet IDs (`WALLET_ID_VAULT/HOT/MERCHANT`), `ATTACKER_PRIVATE_KEY`, `XAI_API_KEY` + `XAI_MODEL`, and `FAKE_USDC_ADDRESS` for the counterfeit scenario. Then:

```bash
npm run cli setup                 # create wallets, print addresses to fund from the faucet
npm run cli setup -- --test-transfer
npm run cli fake-usdc             # deploy the counterfeit token
npm run cli gateway status        # Gateway balances
npm run cli gateway deposit <usdc>
npm run cli refund                # pull testnet USDC back to the hot wallet after unguarded runs
```

For Gemini, add these to `.env`:
- `GEMINI_ENV=sandbox`
- `GEMINI_API_KEY` and `GEMINI_API_SECRET`: an account-scoped key with the **Trader role only**, no transfer or withdraw.

The project owner's sandbox keys are already in their local `.env`. Production also needs `GEMINI_ALLOW_PRODUCTION=1` and only ever affects the guarded pass.

## Gotchas

- **Non-market `--compare` runs overwrite `results/redteam.{json,md}`**, including offline `--fake` runs. Those files are the committed *live* evidence. Pass `--results-dir` for offline runs; if they get overwritten, `git restore results/`. (Market runs default to `results/markets/`.)
- **One wallet-using process at a time.** Live runs share the Circle wallets.
- **Unguarded live runs spend real testnet USDC.** Refund or top up before a demo.
- **Circle's keyless facilitator trial** has an unstated settlement limit per payee. When it runs out, runs switch to the in-repo facilitator and print a note.
- **Gateway settles in batches**: results cite Gateway transfer IDs, not explorer links; seller balances show `pendingBatch` until the batch lands.
- **Pinned packages**: `@x402/*` 2.29.0 and `@circle-fin/x402-batching` 4.0.0. Upgrade deliberately.
- **Gemini tickers expire.** Nothing hard-codes one: the demo event is auto-picked from live data, or set with `GEMINI_DEMO_EVENT`. The offline snapshot shifts expiries so it keeps working. Refresh it with `gemini snapshot` before recording a demo.
- **A live guarded market run with `GEMINI_ENV=sandbox` places real sandbox orders.** The tampering for the attacks happens only on the simulated venue. On a real venue, M9 (last second) is stopped by `slippage`, not `market-state`, because the 30-second expiry can't be faked there.
- **`src/types.ts`, `src/agent/tools.ts`, `src/redteam/naive-agent.ts`** gained market additions in #27. Rebase other branches carefully.
- More in the README's **Known limits** section.

## Open work

1. **Devpost: opt in to the Gemini Prediction Markets bounty.** Deadline **Fri Nov 20, 12:00 PM CST**. Name the endpoints used:
   - List/Get Events and the order book: agent tools, guard checks, odds board.
   - Place/Cancel Order, Active Orders, Positions, Terms Status: behind the guard.
2. **Rehearse the demo** with `docs/DEMO.md`. Segment 6 is the Prediction markets tab. Use the offline replays as the fallback.
3. **Tick the checklists:**
   - `docs/JUDGE_FEEDBACK_PLAN.md`: everything appears built; confirm the live items with a fresh `npm run redteam:api`.
   - `docs/GEMINI_MARKETS_PLAN.md`: all done except the optional live `redteam:market` and the Devpost opt-in.
4. **Optional:** a live `npm run redteam:market` (Arc Testnet + Gemini sandbox), committing `results/markets/redteam.{json,md}`. It spends testnet USDC on the paid-API side.
5. **Optional fix:** make the other `--compare` suites default to their own results folder too, as the market suite does.
6. **Optional:** M10, the cross-rail attack from the Gemini plan (intel demands a USDC "access fee" to the attacker), and tuning Grok's careful prompt for trading.
7. **Bring-your-own-agent / hosted TripWire** (`feat/byo-agent`, owned by a teammate). It lets users point TripWire at their own deployed agent over an HTTP step protocol and run the attacks against it. Open items:
   - rebase onto `main`
   - two failing tests
   - drop the in-process `module` agent type
   - what a hosted version still needs: SSRF protection on agent URLs, fake-ledger-only unguarded runs, auth, a job queue, per-user results

## Docs index

| File | What it covers |
|---|---|
| `README.md` | Full reference: setup, guard rules, scenarios, results, Gemini section, known limits |
| `docs/DEMO.md` | The demo script, including the Prediction markets segment |
| `docs/JUDGE_FEEDBACK_PLAN.md` | Track 1 judge feedback, the plan built from it, acceptance checklist |
| `docs/GEMINI_MARKETS_PLAN.md` | Gemini bounty plan: design decisions, attacks, acceptance checklist |
| `src/gemini/README.md` | Gemini API facts: verified, docs-only, and unconfirmed |
| `docs/RED_TEAM_AUDIT.md` | Whether the score measures what it claims |
| `docs/QUICKNODE_EVIDENCE.md` | Live QuickNode Streams evidence |
| `docs/REDESIGN.md` | The dashboard's visual redesign brief |
| `results/redteam.md` | Latest live paid-API red-team results |
| `results/markets/gemini-sandbox-order.md` | The live Gemini order placed through the market guard |
