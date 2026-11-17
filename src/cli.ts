import 'dotenv/config';
import { fakeUsdcCommand, setupCommand } from './wallet/commands.js';

/**
 * Entry point: `npm run cli <command>`.
 *   setup     — lane A: create Circle wallets on Arc Testnet / show balances [--test-transfer]
 *   fake-usdc — lane A: deploy the counterfeit token for the fake-USDC scenario
 *   run     — lane D: run red-team scenarios (--all | --scenario <id>) [--no-guard] [--fake]
 *   report  — lane D: re-render the latest report
 *
 * Each lane replaces its command's body; keep the dispatch table as is.
 */
type Command = (args: string[]) => Promise<void>;

const notYet = (lane: string): Command => async () => {
  console.error(`Not implemented yet — owned by lane ${lane}. See README.md.`);
  process.exitCode = 1;
};

const commands: Record<string, Command> = {
  setup: setupCommand,
  'fake-usdc': fakeUsdcCommand,
  run: notYet('D (red team & report)'),
  report: notYet('D (red team & report)'),
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
