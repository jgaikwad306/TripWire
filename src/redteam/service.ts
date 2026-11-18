import { ARC_TESTNET, formatUsdc } from '../constants.js';
import { saveHtmlReport } from '../report/html.js';
import { describeResult, renderMarkdown, renderTerminal } from '../report/render.js';
import { saveReport, type HoldSnapshot, type Parties, type SavedReport } from '../report/store.js';
import type { Address, Agent } from '../types.js';
import type { AuditLog } from '../guard/audit.js';
import { createArcClient } from '../chain/arc.js';
import type { CommandIo } from './commands.js';
import { runScenarios, type RunObserver } from './runner.js';
import type { RedTeamScenario } from './scenarios/index.js';
import { buildReport } from './score.js';
import { fakeWorldFactory, liveWorldFactory, runPolicy, type World, type WorldFactory, type WorldOptions, type FacilitatorChoice } from './world.js';

/** Agents are built by the registry, which also knows the ones users register themselves. */
export { BUILTIN_AGENTS as AGENT_KINDS, createAgent } from '../agent/registry.js';

/** A full run spends a few datasets' worth from the hot wallet (honest buys plus customer payments). */
const HOT_BALANCE_NEEDED_IN_DATASETS = 3n;

/**
 * The "hold" rule: before a run, the guard moves anything above the hot wallet's cap
 * into the vault, so the agent only ever has the capped amount within reach. Without a
 * guard this does nothing, which is the point of the baseline. Returns the amount swept.
 * A failed sweep is reported but does not stop the run.
 */
export async function sweepHot(world: World, io: CommandIo): Promise<bigint> {
  // Measured at the vault: the hot wallet also pays gas, so its drop overstates the sweep.
  const before = await world.wallet.getBalance('vault');
  try {
    await world.guard.rebalance();
  } catch (err) {
    io.log(`WARNING: could not sweep the hot wallet: ${err instanceof Error ? err.message : String(err)}`);
    return 0n;
  }
  const swept = (await world.wallet.getBalance('vault')) - before;
  if (swept > 0n) {
    io.log(`Hold: swept ${formatUsdc(swept)} USDC from the hot wallet to the vault ${world.wallet.addressOf('vault')}.`);
  }
  return swept > 0n ? swept : 0n;
}

/**
 * Builds one world up front so missing keys or wallets fail once, clearly, before any
 * scenario runs. On Arc it also reports the hot balance, because an earlier no-guard
 * run may have drained it and every scenario shares that wallet.
 */
async function checkWorld(
  makeWorld: WorldFactory,
  guarded: boolean,
  io: CommandIo,
): Promise<{ hold?: HoldSnapshot; parties: Parties }> {
  const world = await makeWorld();
  try {
    const parties: Parties = { merchant: world.wallet.addressOf('merchant'), attacker: world.attacker };
    // Offline every scenario starts from a fresh ledger, so there is nothing to sweep.
    const swept = world.network === 'fake' ? 0n : await sweepHot(world, io);
    const hot = await world.wallet.getBalance('hot');
    if (world.network !== 'fake') {
      io.log(`Hot wallet ${world.wallet.addressOf('hot')} holds ${formatUsdc(hot)} USDC.`);
      if (hot < world.prices.dataset * HOT_BALANCE_NEEDED_IN_DATASETS) {
        io.log(`WARNING: that is low for a full run. Top it up at ${ARC_TESTNET.faucetUrl} or expect failed purchases.`);
      }
    }
    // Without a guard nothing enforces a cap, so there is no hold rule to record.
    if (!guarded) return { parties };
    return {
      parties,
      hold: {
        hotCap: runPolicy(world.wallet, world.prices).hotBalanceCap,
        hot,
        vault: await world.wallet.getBalance('vault'),
        swept,
      },
    };
  } finally {
    await world.close();
  }
}

export async function runOnce(opts: {
  scenarios: readonly RedTeamScenario[];
  guarded: boolean;
  fake: boolean;
  agent: Agent;
  outDir: string;
  io: CommandIo;
  activitySubject?: Address;
  approval?: WorldOptions['approval'];
  guardStore?: WorldOptions['guardStore'];
  afterPaymentSent?: WorldOptions['afterPaymentSent'];
  observer?: RunObserver;
  facilitator?: FacilitatorChoice;
  /** Append-only record of every payment decision in the run. */
  audit?: AuditLog;
}): Promise<SavedReport> {
  const { scenarios, guarded, fake, agent, outDir, io, activitySubject, approval, guardStore, afterPaymentSent } = opts;
  if (!guarded && !fake) await requireTestnet(io.env);
  const worldOptions: WorldOptions = {
    guarded,
    agent,
    ...(opts.audit ? { audit: opts.audit } : {}),
    ...(opts.facilitator ? { facilitator: opts.facilitator } : {}),
    onFacilitatorSwitch: (reason) => io.log(`  NOTE  ${reason}`),
    ...(activitySubject ? { activitySubject } : {}),
    ...(approval ? { approval } : {}),
    ...(guardStore ? { guardStore } : {}),
    ...(afterPaymentSent ? { afterPaymentSent } : {}),
  };
  const makeWorld = fake ? fakeWorldFactory(worldOptions) : liveWorldFactory(worldOptions, io.env);
  const { hold, parties } = await checkWorld(makeWorld, guarded, io);

  io.log(`\nRunning ${scenarios.length} scenario(s): agent ${agent.name}, guard ${guarded ? 'ON' : 'OFF'}, ${fake ? 'fake ledger' : 'Arc Testnet'}`);
  const startedAt = new Date().toISOString();
  const results = await runScenarios(scenarios, makeWorld, (r) =>
    io.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.title}: ${describeResult(r)}`),
    opts.observer,
  );

  const saved: SavedReport = {
    network: fake ? 'fake' : 'arc-testnet',
    ...(results.length < scenarios.length ? { partial: true } : {}),
    report: buildReport(results, { agentName: agent.name, guarded, startedAt }),
    ...(hold ? { hold } : {}),
    parties,
    ...(approval
      ? {
          approvals: approval.desk.list().map((a) => ({
            item: a.item,
            merchantUrl: a.merchantUrl,
            payTo: a.payTo,
            amount: a.amount,
            status: a.status,
          })),
        }
      : {}),
  };
  const paths = saveReport(saved, renderMarkdown(saved), outDir);
  const htmlPath = saveHtmlReport(saved, undefined, outDir);
  io.log(`\n${renderTerminal(saved)}\n\nReport written to ${paths.markdownPath} and ${paths.jsonPath}\nPage: ${htmlPath}`);
  return saved;
}


/**
 * The unguarded baseline signs whatever it is asked to, so it only ever runs where money
 * is worthless: NETWORK must not name anything but a testnet, and the RPC node must
 * really be Arc Testnet.
 */
export async function requireTestnet(env: NodeJS.ProcessEnv): Promise<void> {
  const network = env.NETWORK?.trim().toLowerCase();
  if (network && !['testnet', 'arc-testnet', 'fake'].includes(network)) {
    throw new Error(`Refusing to run with the guard off: NETWORK is "${env.NETWORK}". Guard-off runs are testnet only.`);
  }
  const chainId = await createArcClient(env.ARC_RPC_URL || undefined).getChainId();
  if (chainId !== ARC_TESTNET.chainId) {
    throw new Error(`Refusing to run with the guard off: the RPC node is chain ${chainId}, not Arc Testnet (${ARC_TESTNET.chainId}).`);
  }
}
