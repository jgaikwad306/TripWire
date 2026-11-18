import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { guardedTools } from '../agent/tools.js';
import { loadEnv, loadPolicy } from '../config.js';
import { formatUsdc } from '../constants.js';
import { ApprovalDesk } from '../guard/approvals.js';
import { createGuard, defaultPolicy, JsonFileGuardStore, type Policy } from '../guard/index.js';
import { httpQuoteFetcher } from '../merchant/quote.js';
import { startMerchant } from '../merchant/server.js';
import { startOwnerConsole } from '../owner/server.js';
import { fakeWorldFactory, LIVE_PRICES, LIVE_SETTLE_MS, waitForTx } from '../redteam/world.js';
import type { Agent, AgentTools, MerchantMode } from '../types.js';
import { serveStdio } from './server.js';

const MERCHANT_MODES: readonly MerchantMode[] = [
  'honest',
  'swap-payto',
  'inflate-price',
  'inject-prompt',
  'retry-loop',
  'fake-owner',
  'move-to-safety',
];
const DEFAULT_STATE_FILE = '.data/guard-state.json';
const DEFAULT_APPROVAL_WAIT_SECONDS = 120;

export const MCP_USAGE = `Usage: npm run -s cli mcp -- [options]

Serves the guard as an MCP server over stdio, so any MCP client (Claude Desktop, Claude Code,
Cursor, a Python agent through an MCP adapter) can pay through it.

  --fake                 offline: in-memory ledger and a local mock merchant, no keys needed
  --attack <mode>        make the mock merchant attack (${MERCHANT_MODES.join(', ')})
  --with-merchant        live only: also run the mock merchant, paid into the merchant wallet
  --state <file>         live only: where limits and payments are kept (default ${DEFAULT_STATE_FILE})
  --approval-wait <s>    seconds a payment waits for the owner when approval applies (default ${DEFAULT_APPROVAL_WAIT_SECONDS})

Live mode uses the Circle wallets from .env and the policy in GUARD_POLICY_PATH
(default guard-policy.json; without the file, a demo policy that allows only the merchant wallet).
Use "npm run -s" so npm prints nothing on stdout: stdout carries the protocol.`;

/** The world factories want an agent. Over MCP the agent is the client, so this one never runs. */
const CLIENT_IS_THE_AGENT: Agent = {
  name: 'mcp-client',
  run: () => Promise.reject(new Error('Over MCP the connected client is the agent.')),
};

interface Served {
  tools: AgentTools;
  instructions: string;
  close(): Promise<void>;
}

const log = (line: string): void => {
  process.stderr.write(`[tripwire-guard] ${line}\n`);
};

const parseMode = (value: string | undefined): MerchantMode => {
  const mode = (value ?? 'honest') as MerchantMode;
  if (!MERCHANT_MODES.includes(mode)) throw new Error(`--attack must be one of ${MERCHANT_MODES.join(', ')}.`);
  return mode;
};

const merchantInstructions = (url: string, prices: Record<string, bigint>): string =>
  `A merchant is running at ${url}. Items: ${Object.entries(prices)
    .map(([item, price]) => `"${item}" (${formatUsdc(price)} USDC)`)
    .join(', ')}. ` +
  'To buy: get_quote, then merchant_request POST /buy {"item": ...} to get payment details, then request_payment, ' +
  'then merchant_request POST /buy again with the txHash. Every payment goes through the wallet guard, which may refuse it.';

/** Offline: the same world the red team runs in, with the connected client as the agent. */
async function serveFake(mode: MerchantMode): Promise<Served> {
  const world = await fakeWorldFactory({ guarded: true, agent: CLIENT_IS_THE_AGENT })();
  world.merchant.setMode(mode);
  log(`offline mode: fake ledger, mock merchant at ${world.merchant.url} (${mode})`);
  return {
    tools: world.tools,
    instructions: merchantInstructions(world.merchant.url, world.prices),
    close: () => world.close(),
  };
}

/** Arc Testnet: the Circle wallets, the owner's policy, and limits that survive restarts. */
async function serveLive(opts: { state: string; approvalWaitMs: number; withMerchant: boolean; mode: MerchantMode }): Promise<Served> {
  const env = loadEnv();
  // Loaded lazily so offline use never touches the Circle SDK.
  const { createLiveWallet } = await import('../wallet/index.js');
  const { wallet, chain } = await createLiveWallet();
  const policy: Policy = existsSync(env.GUARD_POLICY_PATH) ? loadPolicy(env.GUARD_POLICY_PATH) : defaultPolicy(wallet);
  log(
    existsSync(env.GUARD_POLICY_PATH)
      ? `policy: ${env.GUARD_POLICY_PATH}`
      : `policy: demo default (only the merchant wallet ${wallet.addressOf('merchant')} is payable)`,
  );

  const store = new JsonFileGuardStore(opts.state);
  store.load(); // an unreadable state file is reported before anything is served
  const approvals = new ApprovalDesk();
  // The approval page's address carries the owner's token, so it goes to stderr (the
  // owner's terminal) and never into anything the agent can read.
  const owner = policy.approvalThreshold === undefined ? undefined : await startOwnerConsole(approvals);
  if (owner && policy.approvalThreshold !== undefined) {
    log(`payments above ${formatUsdc(policy.approvalThreshold)} USDC wait for approval at ${owner.url}`);
  }
  const guard = createGuard({
    wallet,
    chain,
    fetchQuote: httpQuoteFetcher,
    policy,
    store,
    approvals,
    approvalWaitMs: opts.approvalWaitMs,
  });

  const merchant = opts.withMerchant
    ? await startMerchant({
        payTo: wallet.addressOf('merchant'),
        attacker: wallet.addressOf('attacker'),
        prices: { ...LIVE_PRICES },
        verifyPayment: async (req) => {
          // A just-confirmed payment can reach the RPC node a moment after the wallet reports it.
          await waitForTx(chain, req.txHash, LIVE_SETTLE_MS).catch(() => null);
          return guard.verifyReceipt(req);
        },
      })
    : undefined;
  merchant?.setMode(opts.mode);
  if (merchant) log(`mock merchant at ${merchant.url} (${opts.mode})`);
  log(`live mode on Arc Testnet: hot wallet ${wallet.addressOf('hot')}, state in ${opts.state}`);

  return {
    tools: guardedTools(guard),
    instructions: merchant
      ? merchantInstructions(merchant.url, LIVE_PRICES)
      : 'Pay merchants through this wallet: get_quote, then request_payment. Every payment goes through the wallet guard, which may refuse it.',
    close: async () => {
      await Promise.all([merchant?.close(), owner?.close()]);
    },
  };
}

export async function mcpCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      fake: { type: 'boolean', default: false },
      attack: { type: 'string' },
      'with-merchant': { type: 'boolean', default: false },
      state: { type: 'string', default: DEFAULT_STATE_FILE },
      'approval-wait': { type: 'string', default: String(DEFAULT_APPROVAL_WAIT_SECONDS) },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stderr.write(`${MCP_USAGE}\n`);
    return;
  }
  // stdout carries the protocol: anything a library logs must not land there.
  console.log = console.error;
  console.info = console.error;

  const mode = parseMode(values.attack);
  const waitSeconds = Number(values['approval-wait']);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error('--approval-wait must be a number of seconds.');
  if (values.fake && values['with-merchant']) throw new Error('--fake always runs the mock merchant; drop --with-merchant.');
  if (!values.fake && !values['with-merchant'] && values.attack) {
    throw new Error('--attack needs the mock merchant: add --fake or --with-merchant.');
  }

  const served = values.fake
    ? await serveFake(mode)
    : await serveLive({ state: values.state, approvalWaitMs: waitSeconds * 1000, withMerchant: values['with-merchant'], mode });
  log('ready');
  try {
    await serveStdio({ tools: served.tools, instructions: served.instructions });
  } finally {
    await served.close();
  }
}
