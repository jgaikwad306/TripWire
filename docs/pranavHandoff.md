# TripWire demo handoff

How to set up and run the TripWire demo on a new Mac. One-time setup takes about 10 minutes. On demo day, start about 30 minutes before presenting.

## One-time setup (before demo day)

### 1. Install tools

Skip anything already installed. Homebrew: https://brew.sh

```bash
brew install node cloudflared git
node -v   # should be v20 or newer
```

### 2. Get the code

The repo is **private**. Pick one:

**Option A: clone it** (you must be added as a collaborator on GitHub first, and be signed in to GitHub on this Mac):

```bash
cd ~
git clone https://github.com/jgaikwad306/TripWire.git
cd TripWire
git checkout main && git pull
npm install
```

**Option B: get a zip by AirDrop** (fastest if you're in the same room). The sender zips the TripWire folder **without** `node_modules` and `.data`:

```bash
# on the sender's Mac, in the TripWire folder
npm run demo:zip          # writes ~/TripWire.zip; refuses to keep it if a .env or .data slipped in
```

Then on your Mac, unzip it into your home folder and run:

```bash
cd ~/TripWire
npm install
```

Always run `npm install` on your own Mac. Don't copy someone else's `node_modules`.

### 3. Get the `.env` file

The `.env` holds the Circle API key, wallet IDs, attacker private key, xAI key and QuickNode key. With it you use the same wallets and funds as the rest of the team.

- Get it by **AirDrop** or USB. **Never** send it over Slack, Discord, email or Git.
- Put it at `~/TripWire/.env`.
- Open it and find the line starting with `QUICKNODE_STREAMS_DATA_DIR=`. Change it to exactly this (there should be only one such line):

  ```
  QUICKNODE_STREAMS_DATA_DIR=.data/streams-live
  ```

  This gives your Mac its own fresh Stream, so it doesn't have to replay hours of old blocks.

### 4. Check that it works

```bash
npm test
npm run demo:check         # tools, .env keys, Streams settings, recordings, Gateway balance
npm run demo:replay        # offline fallback; opens a link to view in the browser
```

`demo:check` prints `ok`, `WARN` or `FAIL` for each item, and the command that fixes anything not ok. It changes nothing. Fix every `FAIL` before demo day.

## Demo day (start about 30 minutes before presenting)

**Only one Mac should run the monitor for the demo wallets.** Make sure the other teammate has stopped theirs (Ctrl+C) before you start.

### One command

```bash
cd ~/TripWire
npm run demo:check     # fix any FAIL first
npm run demo:live
```

`demo:live` does everything the four terminals below used to, in one terminal:

1. runs the preflight checks again and stops if anything fails;
2. starts the Streams monitor (or reuses one already running);
3. starts the cloudflared tunnel and reads its `https://….trycloudflare.com` URL for you;
4. points the QuickNode Stream at `<tunnel>/webhooks/quicknode` (creates it on the first run, re-targets it after a restart), backfilling 1000 blocks;
5. shows backfill progress until the Stream is `ready` (usually 5–10 minutes);
6. starts the dashboard: open the `127.0.0.1:<port>` link it prints. It defaults to **Arc Testnet + Grok**. Click **Run comparison**.

It also keeps the Mac awake while it runs. Keep the laptop plugged in and leave that terminal open. **Ctrl+C** stops everything; the dashboard finishes its current scenario first.

Options: `npm run demo:live -- --agent grok-careful`, `--port 3000`, `--backfill-blocks 1000`, `--wait-minutes 20`, `--no-dashboard`. Logs for the monitor, tunnel and dashboard are in `.data/streams-live/demo-logs/`.

### By hand (if `demo:live` won't start)

The same steps in four terminals. Terminals 1, 2 and 4 stay open the whole time.

**Terminal 1: monitor**

```bash
cd ~/TripWire
npm run cli streams serve
```

Wait until it prints `Webhook: http://127.0.0.1:4021/webhooks/quicknode`.

**Terminal 2: tunnel**

```bash
cloudflared tunnel --url http://127.0.0.1:4021 --no-autoupdate --protocol http2
```

Scroll **up** to the box near the top and copy the `https://….trycloudflare.com` URL. The lines at the bottom (`Registered tunnel connection`) mean it is working.

**Terminal 3: connect the Stream, wait, then run**

```bash
cd ~/TripWire
npm run cli streams setup -- --webhook-url https://PASTE-URL.trycloudflare.com/webhooks/quicknode --backfill-blocks 1000
```

It should print a new `streamId`. Then repeat this until it shows `"ready": true` (usually 5–10 minutes; `coveredThrough` should keep going up):

```bash
npm run cli streams status
```

Then start the dashboard and open the `127.0.0.1:<port>` link it prints:

```bash
npm run dashboard
```

**Terminal 4: keep the Mac awake**

```bash
caffeinate -dims
```

## Before presenting

- Check balances: `npm run demo:check` (or `npm run setup-wallets` for every wallet). The hot wallet needs at least **1.1 USDC in Gateway**. Recover what earlier unguarded runs spent with `npm run refund`, then top up with:

  ```bash
  npm run gateway:deposit -- 2
  ```

- Demo script: `docs/DEMO.md`.

## Common mistakes

- **By hand only:** no spaces in the webhook URL. It must end in `/webhooks/quicknode` with no gap. (`demo:live` builds it for you.)
- **By hand only:** don't drop `setup` or the `--` in the Terminal 3 command. `npm run cli streams setup -- --webhook-url ...` exactly.
- **`Cannot find package ...`**: run `npm install` again.
- **In `--fake` mode the Wallet monitoring section may say "Spending blocked".** Ignore it; offline runs don't use the monitor and still work.

## If something goes wrong

- **Tunnel or monitor stopped:** guarded spending is blocked, and `demo:live` prints a `!!` warning. Press Ctrl+C and run `npm run demo:live` again: it starts a new tunnel and points the same Stream at it. (By hand: restart Terminals 1 and 2, then rerun the Terminal 3 `setup` command with the **new** tunnel URL; it changes every time cloudflared restarts.)
- **Spending frozen by an alert:** run `npm run cli streams status`, copy the alert `id`, then:

  ```bash
  npm run cli streams unfreeze -- --alert-id '<id>' --reason 'Reviewed testnet transfer'
  ```

- **Wi-Fi bad or anything breaks on stage:** run `npm run demo:replay`. It plays a recorded run with no internet or keys needed.
- **Need to show the UI without any of the live setup:** `npm run dashboard -- --fake --agent grok` runs the same attacks with simulated money (Grok is still real). No monitor, tunnel or Stream needed.

## Shutting down

Press **Ctrl+C** (in each terminal, if you ran it by hand). Then pause the Stream on the QuickNode dashboard (dashboard.quicknode.com → Streams → "TripWire USDC wallet safety" → Pause), so it stops trying to send to a dead tunnel.

Only one machine should run the monitor for the demo wallets at a time.
