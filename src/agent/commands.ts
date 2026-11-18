import { parseArgs } from 'node:util';
import { agentChoices, loadAgentRegistry, DEFAULT_AGENTS_FILE } from './registry.js';
import { REMOTE_PROTOCOL, RemoteAgent } from './remote.js';
import { TOOL_DEFS } from './tools.js';

interface Io {
  env: NodeJS.ProcessEnv;
  log(message: string): void;
}

const USAGE = `Usage: npm run cli agents -- [--probe <id>]

Lists the agents you can test: the built-in ones and those registered in ${DEFAULT_AGENTS_FILE}
(or TRIPWIRE_AGENTS_FILE), with any environment variables they still need.

  --probe <id>   send one step to a deployed (http) agent and check its reply follows
                 ${REMOTE_PROTOCOL}. Nothing is paid: the tool calls it asks for are shown, not run.

Then test one:  npm run cli run -- --all --compare --fake --agent <id>`;

/** The task a probe sends. Any well-behaved agent should ask for a tool or answer. */
const PROBE_TASK = 'This is a connectivity check from TripWire. Call check_balance, or reply with a short message.';

/** `npm run cli agents` — list registered agents, or check that a deployed one speaks the protocol. */
export async function agentsCommand(args: string[], io: Io = { env: process.env, log: (m) => console.log(m) }): Promise<void> {
  const { values } = parseArgs({ args, options: { probe: { type: 'string' }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    io.log(USAGE);
    return;
  }
  const registry = loadAgentRegistry(io.env);

  if (values.probe) {
    const spec = registry.specs.find((s) => s.id === values.probe);
    if (!spec) throw new Error(`No agent "${values.probe}" in ${registry.file ?? DEFAULT_AGENTS_FILE}.`);
    if (spec.type !== 'http') throw new Error(`--probe checks deployed (http) agents; "${spec.id}" is a ${spec.type} agent. Run it with --fake instead.`);
    const token = spec.tokenEnv ? io.env[spec.tokenEnv] : undefined;
    if (spec.tokenEnv && !token) throw new Error(`Agent "${spec.id}" needs ${spec.tokenEnv} set in .env.`);
    const agent = new RemoteAgent({ url: spec.url, name: spec.id, ...(token ? { token } : {}), ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}) });
    const started = Date.now();
    const reply = await agent.step({
      protocol: REMOTE_PROTOCOL,
      run_id: 'probe',
      step: 0,
      max_steps: 1,
      task: PROBE_TASK,
      tools: TOOL_DEFS,
      messages: [{ role: 'user', content: PROBE_TASK }],
    });
    io.log(`OK: ${spec.url} answered in ${Date.now() - started} ms with a valid ${REMOTE_PROTOCOL} reply.`);
    const calls = reply.tool_calls ?? [];
    if (calls.length) io.log(`It asked for: ${calls.map((c) => c.name).join(', ')} (not run).`);
    else io.log(`It answered: ${(reply.message ?? '').slice(0, 300) || '(empty message)'}`);
    const known = new Set(TOOL_DEFS.map((t) => t.function.name));
    const unknown = calls.filter((c) => !known.has(c.name)).map((c) => c.name);
    if (unknown.length) io.log(`Warning: unknown tool(s) ${unknown.join(', ')}; they would come back as errors.`);
    return;
  }

  io.log(registry.file ? `Agents (custom ones from ${registry.file}):` : `Agents (no ${DEFAULT_AGENTS_FILE} found; copy agents.example.json to register your own):`);
  for (const choice of agentChoices(registry)) {
    const missing = choice.requiredEnv.filter((key) => !io.env[key]);
    const status = missing.length ? `needs ${missing.join(', ')}` : 'ready';
    io.log(`  ${choice.id.padEnd(16)} ${choice.kind.padEnd(8)} ${choice.label.padEnd(32)} ${status}`);
  }
}
