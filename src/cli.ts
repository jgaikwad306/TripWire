import 'dotenv/config';
import { buyCommand, compareCommand, noGuardCommand, reportCommand, runCommand } from './redteam/commands.js';
import { fakeUsdcCommand, refundCommand, setupCommand } from './wallet/commands.js';

/**
 * Entry point: `npm run cli <command>`.
 *   setup     — create Circle wallets on Arc Testnet / show balances [--test-transfer]
 *   fake-usdc — deploy the counterfeit token for the fake-USDC scenario
 *   run       — run red-team scenarios (--all | --scenario <id>) [--no-guard] [--compare] [--fake]
 *   no-guard  — shortcut for `run --all --no-guard`: the unprotected baseline
 *   compare   — shortcut for `run --all --compare`: guarded, then unguarded, side by side
 *   buy       — one paid API purchase: buy a wallet's USDC activity report and answer from it [--address 0x…]
 *   refund    — return testnet USDC from the attacker and merchant to the hot wallet [--keep <usdc>] [--dry-run]
 *   report    — re-render the latest report [--html]
 */
type Command = (args: string[]) => Promise<void>;

const commands: Record<string, Command> = {
  setup: setupCommand,
  'fake-usdc': fakeUsdcCommand,
  run: (args) => runCommand(args),
  'no-guard': (args) => noGuardCommand(args),
  compare: (args) => compareCommand(args),
  buy: (args) => buyCommand(args),
  refund: refundCommand,
  report: (args) => reportCommand(args),
};

const [name, ...args] = process.argv.slice(2);
const command = name ? commands[name] : undefined;

if (!command) {
  console.log(`Usage: npm run cli <${Object.keys(commands).join('|')}>`);
  process.exitCode = name ? 1 : 0;
} else {
  try {
    await command(args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
