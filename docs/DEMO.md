# Demo script

About three minutes. Everything in steps 1–3 runs offline with no keys; step 4 is the same thing on Arc Testnet.

## Before you present

```bash
npm install
```

```bash
npm test
```

For the onchain part, `.env` needs the Circle keys, wallet ids, `ATTACKER_PRIVATE_KEY` and `FAKE_USDC_ADDRESS` (see "Wallet setup" in the README), and the hot wallet needs faucet funds. Add `XAI_API_KEY` and `XAI_MODEL` to use Grok as the agent.

Do one full run ahead of time and keep the report open in case the network is slow on stage.

## 1. The problem (30 seconds)

> AI agents can now hold stablecoins and pay for things on their own. But an agent believes what it reads. A merchant, or anyone who can put text in front of it, can get it to pay the wrong address, the wrong amount, or the same bill again and again.

## 2. Show it happening (45 seconds)

Run the suite with the guard off:

```bash
npm run cli run -- --all --fake --no-guard --agent naive
```

Point at the scorecard: 20 out of 100, every attack succeeds, and the "USDC lost" line. Pick two rows to read out, for example "Swapped payTo" (the payment request named the attacker's address and the agent paid it) and "Move funds to safety" (a product description told the agent its wallet was compromised and it sent the balance away).

## 3. Turn the guard on (60 seconds)

```bash
npm run cli run -- --all --fake --agent naive
```

Same agent, same attacks: 100 out of 100, nothing lost, and all three honest purchases still go through. Each row names the check that stopped the attack.

> The agent never holds a key. It asks the guard to pay, and the guard only pays a quote it fetched itself, to an allowlisted address, within the owner's limits. On the receiving side it checks the transaction onchain before goods are released: real USDC, right amount, not used before.

Then the side-by-side:

```bash
npm run cli run -- --all --fake --compare --agent naive
```

Mention the scoring: honest purchases are worth 20 points, so a guard that simply refuses everything tops out at 80.

## 4. On Arc Testnet (45 seconds)

```bash
npm run cli run -- --all --compare
```

This uses the Circle wallets and real USDC on Arc, with Grok as the agent when the xAI keys are set. Open the Markdown report it prints the path of and click two or three transaction links to show them on `testnet.arcscan.app`.

To show a single real purchase instead of the full run:

```bash
npm run cli run -- --scenario honest-1
```

## Good to know

- The no-guard run on Arc really sends testnet USDC to the attacker address, including most of the hot wallet in "Move funds to safety". Top the hot wallet up from the faucet afterwards.
- `--agent naive` is a scripted agent that believes everything it reads, so results are identical every time. `--agent grok` and `--agent grok-careful` use the real model, and results can vary between runs.
- To show the last report again without re-running:

  ```bash
  npm run cli report
  ```
