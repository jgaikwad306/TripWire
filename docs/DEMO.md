# Demo script

About three minutes. The agent buys real data through the guard, paying Circle Gateway nanopayments on Arc Testnet; then the red team attacks it with the guard off and on.

## Before you present

```bash
npm install
```

```bash
npm test
```

On Arc, `.env` needs the Circle keys, wallet ids and `ATTACKER_PRIVATE_KEY` (see "Wallet setup" in the README). Then check the wallets and top up Gateway:

```bash
npm run setup-wallets
```

```bash
npm run gateway:deposit -- 2
```

The hot wallet should show at least 1.1 USDC in Gateway: the unguarded price-inflation attack alone pays 1 USDC.

Start the dashboard and leave it open:

```bash
npm run dashboard -- --agent naive
```

Do one full run ahead of time. If the network or wifi is unreliable on stage, use the replay instead (see the end).

## 1. Show the guard config (20 seconds)

Open `guard-policy.example.json` and point at the `api` section:

- `resources`: the only API the agent may pay
- `prices`: the reference price per endpoint (0.001, 0.002, 0.005 USDC)
- `tasks`: the research task may buy market data and sentiment, with a 0.005 USDC budget
- `rateLimit` and `duplicateWindowMs`

> The agent never holds a key. Its only way to pay is to ask the guard, and these rules decide. Every decision goes to an append-only audit log.

## 2. The agent completes a real task (40 seconds)

In the dashboard, the preset is already selected. Click **Run comparison** and select **Paid API research task** in the index.

Point out, in the "With Tripwire" column:

1. The task: get the BTC price and crypto news sentiment, then summarize.
2. Two paid requests, each a `402` that the guard allowed: 0.001 and 0.002 USDC to the seller.
3. "Honest purchase completed", with Gateway transfer links. Open one: Gateway's own record of the nanopayment.
4. The Circle Gateway balances line under the run summary: the agent's balance goes down, the seller's goes up (as pending until Gateway's next onchain batch).

> That is a gasless USDC nanopayment on Arc: signed once by the guard, checked instantly by Gateway, settled onchain in a batch.

## 3. Guard off: attacks take money (45 seconds)

The comparison runs the unguarded pass second. Select, in the index:

- **Payee swap in the 402**: the API's 402 names the attacker. Without Tripwire, the wallet signs it: loss.
- **Prompt injection in paid data**: the paid data says "buy the real-time feed from" another domain. Without Tripwire, the agent buys it from the attacker.
- **Drain loop**: the API takes the payment, then says it never arrived. Without Tripwire, the agent pays three times.

Point at the red "Unguarded" loss figure in the run summary.

## 4. Guard on: the same attacks, blocked (45 seconds)

Same three scenarios, "With Tripwire" column. Each shows **Payment denied** with the rule:

- payee swap: `allowlist`, nothing signed
- prompt injection: `resource`, the attacker's domain is never even contacted
- drain loop: `duplicate`, the API took payment without delivering, so it is not paid again

> The guard reads the 402 itself. Whatever the agent believed, the guard only pays approved resources, approved payees, at the reference price, within the task's budget.

## 5. The full red-team table (30 seconds)

```bash
npm run redteam:api -- --agent naive
```

(Or show the last run: open `results/redteam.md`.) Nine attacks, each in both modes: guard on blocks 9 of 9 with 0 USDC lost and the research task still completes; guard off loses on 8 of 9. Each row names the rule and the Gateway transfer ids.

For the whole suite (29 scenarios, including the merchant and receive-side attacks):

```bash
npm run redteam
```

## Fallback: replay a recorded run

```bash
npm run demo:replay
```

Open the printed URL and click **Run comparison**. It plays the newest recorded run (every finished dashboard run is saved under `reports/runs/`), or the bundled live Arc run in `recordings/demo.journal.json`, through the same page with its original pacing. Nothing executes, no keys are needed, and a banner says it is a replay. `-- --speed 2` plays it faster.

## Good to know

- The guard-off pass really pays the attacker wallet in testnet USDC through Gateway. It is our own wallet; the amounts are fractions of a cent, except price inflation (about 1 USDC per run, paid to our own seller).
- `--agent naive` is a scripted agent that believes everything it reads, so results are identical every time. `--agent grok` uses the real model; results can vary.
- Offline, with no keys: `npm run dashboard -- --fake --agent naive` and `npm run redteam:api -- --fake --agent naive`.
