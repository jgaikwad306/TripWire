# TripWire handoff

Status as of 2026-11-18. For whoever picks the project up next. The README has the full reference; this is the map, the current state, and what's left.

## What TripWire is

A guarded USDC wallet for AI agents on **Circle Arc**, plus a **red team** that attacks the agent and scores how safe it is. The agent (an LLM) never holds a key: it asks the guard to pay, and the guard checks every hold, send, receive and paid API call before it signs anything. Every attack runs twice, guard on and guard off, so the report shows exactly what the guard saved.

Built for the UBC 2026 hackathon, Track 1: Agentic Payments & AI. Judge feedback and the plan that came from it: `docs/JUDGE_FEEDBACK_PLAN.md`.

Headline result (live Arc Testnet, real Circle Gateway nanopayments, `results/redteam.md`):

| | Guard on | Guard off |
|---|---|---|
| Paid-API attacks blocked | 9 / 9 | 0 / 9 |
| USDC lost | 0 | 3.038 |
| Honest research task completed | yes | yes |

## Branches: read this first

| Branch | State |
|---|---|
| `feat/gateway-nanopayments` | **The current app.** Paid API, Gateway nanopayments, the 9 API attacks, recorded runs and replay, live results. 5 commits ahead of `main`. **No PR open yet.** |
| `main` | Behind. Has nothing the Gateway branch lacks, so the merge is conflict-free. |
| `feat/byo-agent` | WIP "bring your own agent" feature (see below). Built on the Gateway branch. A teammate owns it. |
| `docs/handoff` | This file. |

**First task: open a PR from `feat/gateway-nanopayments` into `main`.**

## Architecture

Everything runs locally as one Node/TypeScript process. There is no hosted backend and no database: state is JSON files on disk. That's deliberate: the process holds wallet keys from `.env`, so servers bind to `127.0.0.1` behind a session token, and runs share real wallets, so only one runs at a time.

```
LLM agent ──tool calls──▶ Guard ──signs only if every check passes──▶ x402 payment
 (src/agent)              (src/guard)                                  │
                                                                       ▼
          Mock merchant (src/merchant) · Paid API (src/paid-api) · Circle facilitator / Gateway
                                                                       │
                                                                       ▼
                                                              Arc Testnet (USDC)
```

| Folder | What lives there |
|---|---|
| `src/types.ts` | The shared contracts every part compiles against. Change with care. |
| `src/guard/` | Policy, intents, send/receive/API checks, hold (hot/vault sweep), approvals, persisted state, audit log |
| `src/agent/` | Grok tool-use loop (any OpenAI-compatible API), tool definitions |
| `src/merchant/`, `src/paid-api/` | The shop and the paid x402 data API, each with attack modes the red team switches on |
| `src/wallet/`, `src/chain/` | Circle developer-controlled wallets, Gateway, Arc chain reader, refund, counterfeit token |
| `src/x402/` | Protocol helpers on the official `@x402` packages; Circle facilitator, local facilitator, fallback, Gateway client |
| `src/redteam/` | Scenarios, runner, scoring, the scripted (naive) agent, CLI commands |
| `src/report/` | JSON / Markdown / HTML / terminal reports, `results/redteam.{json,md}` |
| `src/dashboard/` | The live attack lab: local HTTP server, event stream, browser client, run recordings |
| `src/owner/` | Local page where the owner approves large payments |
| `src/streams/` | Optional QuickNode Streams monitoring of wallet outflows |
| `src/fakes/` | In-memory ledger, guard, merchant: everything in `test/` runs offline on these |

### Scenarios

- **9 paid-API attacks** (Gateway nanopayments): prompt injection in paid data, payee swap, 1000x price inflation, drain loop, salami slicing, wrong network, redirect to unapproved domain, duplicate charge, off-task purchase.
- **Send, receive and hold attacks** on the merchant flow (swapped payTo, inflated price, prompt injection, payment loop, fake owner, move-to-safety, forged/counterfeit/replayed payments, self-approval, …).
- **Honest controls** (H1–H5): purchases that must still succeed with the guard on.

The full catalog with descriptions is in `src/dashboard/catalog.ts`; the dashboard's **Configure** shows all of them.

## Running it

```bash
npm install
cp .env.example .env
```

| Goal | Command |
|---|---|
| Visual demo, offline, no keys | `npm run dashboard -- --fake --agent naive` |
| Visual demo, live (Arc Testnet + Grok) | `npm run dashboard` |
| Replay a recorded run, offline | `npm run demo:replay` |
| Paid-API attacks in the terminal, offline | `npm run redteam:api -- --fake --results-dir reports/offline` |
| Same, live | `npm run redteam:api` |
| All attacks | `npm run redteam` (add `--fake --results-dir reports/offline` offline) |
| One paid purchase end to end | `npm run buy` |
| Tests (offline) / types | `npm test` / `npm run typecheck` |
| Read-only checks against real Arc | `LIVE=1 npm test` |

Dashboard: open the printed URL (it contains a private token), click **Run comparison**.

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

## Gotchas

- **`--compare` runs overwrite `results/redteam.{json,md}`**, including offline `--fake` runs. Those files are the committed *live* evidence. Pass `--results-dir` for offline runs; if they get overwritten, `git restore results/`.
- **One wallet-using process at a time.** Live runs share the Circle wallets.
- **Unguarded live runs spend real testnet USDC.** Refund or top up before a demo.
- **Circle's keyless facilitator trial** has an unstated settlement limit per payee. When it runs out, runs switch to the in-repo facilitator and print a note.
- **Gateway settles in batches**: results cite Gateway transfer IDs, not explorer links; seller balances show `pendingBatch` until the batch lands.
- **Pinned packages**: `@x402/*` 2.29.0 and `@circle-fin/x402-batching` 4.0.0. Upgrade deliberately.
- More in the README's **Known limits** section.

## Open work

1. **Merge the Gateway work**: PR `feat/gateway-nanopayments` → `main`.
2. **Tick the judge checklist** at the bottom of `docs/JUDGE_FEEDBACK_PLAN.md`. Everything on it appears built; confirm the live items with a fresh `npm run redteam:api` against Arc.
3. **Rehearse the demo** with `docs/DEMO.md`, including the offline `npm run demo:replay` fallback.
4. **Optional fix**: make offline comparison runs write somewhere other than `results/` by default, so they can't clobber the live evidence.
5. **Bring-your-own-agent / hosted TripWire** (`feat/byo-agent`, owned by a teammate): lets users point TripWire at their own deployed agent over an HTTP step protocol and run the attacks against it. The commit message lists its open items (two failing tests, dropping the in-process `module` agent type, and what a hosted version still needs: SSRF protection, fake-ledger-only unguarded runs, auth, a job queue, per-user results).

## Docs index

| File | What it covers |
|---|---|
| `README.md` | Full reference: setup, guard rules, scenarios, results, known limits |
| `docs/DEMO.md` | The ~3-minute demo script |
| `docs/JUDGE_FEEDBACK_PLAN.md` | Judge feedback, the plan built from it, acceptance checklist |
| `docs/RED_TEAM_AUDIT.md` | Whether the score measures what it claims |
| `docs/QUICKNODE_EVIDENCE.md` | Live QuickNode Streams evidence |
| `docs/REDESIGN.md` | The dashboard's visual redesign brief |
| `results/redteam.md` | Latest live red-team results table |
