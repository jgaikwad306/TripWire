# QuickNode Streams live evidence

Captured 2026-11-17T21:50:20.186Z. This is a real Arc Testnet Stream and authenticated webhook, with the hot and vault wallets monitored for USDC outflows. The merchant is included for incoming receipt verification.

| Setting | Live configuration |
| --- | --- |
| Stream ID | `725f4c2e-ae55-46e2-bc17-b7e635b12f42` |
| Network | Arc Testnet, chain ID 5042002 |
| Dataset | `block_with_receipts` |
| Filter | [JavaScript template](../src/streams/filter.js), rendered with the existing Circle wallet addresses |
| Destination | HTTPS webhook at `https://keeping-competitions-broadcasting-disposition.trycloudflare.com/webhooks/quicknode` |
| Initial range | Blocks 72732374–72742373 (10,000 blocks), continuing to the chain tip |
| Batch size | 1, this account's maximum; elastic batching enabled |

The deployed filter was downloaded through QuickNode's API and matched byte-for-byte against the repository's rendered filter. Its SHA-256 is `fb8950f8d43c794f7c12e4d7f82ce75267c97ac7766cc6796b35b020266a7723`. [Full nonsecret evidence](quicknode-evidence.json) includes the watched addresses and captured status.

## Verified behavior

- Historical receipt and authorization recovery: [payment at block 72734984](https://testnet.arcscan.app/tx/0x0e9915dc774cf65b57a098836f4f3fc3e73e7dfc0c32a7cb9e16461924fb72ff), 8,600 blocks behind the head at verification, was retrieved from actual signed Stream deliveries persisted in the journal.
- Stale monitoring: the actual purchasing CLI refused payment with check `monitoring`, no transaction, and zero loss.
- Authorized purchase: a [0.05-USDC x402 payment](https://testnet.arcscan.app/tx/0x6dc9236f7e105f805f59e1c3b2785b7bf695301e0dc37bbfcf5bd5754907320d) delivered the paid wallet-activity report. Its receipt and authorization transaction were also retrieved from the Stream index.
- Unexpected outflow: a controlled [0.001-USDC hot-wallet transfer](https://testnet.arcscan.app/tx/0xf473af47c0ffd0b5ed7b54177a94fbd589d01a5e59a08495ea2148c29538916c) bypassed the guard and raised alert `0xf473af47c0ffd0b5ed7b54177a94fbd589d01a5e59a08495ea2148c29538916c:14`.
- Frozen agent: the actual purchasing CLI then refused another payment with check `monitoring` and a frozen-spending reason, without submitting a transaction. The freeze also survived a monitor restart.
- Recovery: only that controlled test alert was explicitly acknowledged after verification. The monitor returned to ready, unfrozen operation.
- Automated checks: `npm test` — 398 passed, three unrelated live RPC tests skipped; `npm run typecheck` passed. Browser rendering checks cover monitor progress, freeze status, native precision, and escaped alert text.

## Reproduce

Follow the [README setup](../README.md#quicknode-streams-usdc-monitoring-and-backfill). Keep the monitor and temporary HTTPS tunnel running; a new tunnel hostname requires rerunning setup with the new URL. Local secrets and the journal stay in ignored `.data/streams/`. The API key and HMAC/control tokens are excluded from these artifacts.

With monitoring ready and the hot wallet funded, `npm run cli buy -- --agent naive` exercises the authorized purchase. The existing `npm run cli refund` command can return funds from earlier demo runs. To deliberately exercise detection using your own testnet wallets, `npm run cli setup -- --test-transfer` sends 0.01 USDC hot → merchant outside the guard. Inspect `streams status`, verify that another guarded purchase is refused, and acknowledge that specific controlled alert with `streams unfreeze -- --alert-id … --reason …`. A freeze cannot revoke an already signed authorization or reverse a completed transfer.
