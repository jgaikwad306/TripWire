import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import OpenAI from 'openai';
import { z } from 'zod';
import { NaiveAgent } from '../redteam/naive-agent.js';
import type { Agent } from '../types.js';
import { CAREFUL_SYSTEM_PROMPT, GrokAgent, createXaiClient } from './grok.js';
import { RemoteAgent } from './remote.js';

/**
 * Agents users bring themselves, registered in a JSON file (default `agents.json`, or
 * TRIPWIRE_AGENTS_FILE). Secrets are never written there: entries name the environment
 * variable that holds them. See docs/BRING_YOUR_OWN_AGENT.md and agents.example.json.
 */
export const DEFAULT_AGENTS_FILE = 'agents.json';

export const BUILTIN_AGENTS = ['naive', 'grok', 'grok-careful'] as const;
export type BuiltinAgent = (typeof BUILTIN_AGENTS)[number];

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an environment variable name, e.g. MY_AGENT_TOKEN');
const common = {
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'must be lowercase letters, digits and dashes (up to 40)')
    .refine((id) => !(BUILTIN_AGENTS as readonly string[]).includes(id), 'is a built-in agent name'),
  label: z.string().min(1).max(60).optional(),
  maxSteps: z.number().int().min(1).max(50).optional(),
};

const agentSpecSchema = z.discriminatedUnion('type', [
  z.object({
    ...common,
    type: z.literal('http'),
    url: z.string().url(),
    tokenEnv: envName.optional(),
    timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  }).strict(),
  z.object({
    ...common,
    type: z.literal('openai'),
    baseUrl: z.string().url(),
    model: z.string().min(1),
    apiKeyEnv: envName.optional(),
    systemPrompt: z.string().min(1).optional(),
    systemPromptFile: z.string().min(1).optional(),
  }).strict(),
  z.object({
    ...common,
    type: z.literal('module'),
    path: z.string().min(1),
    export: z.string().min(1).optional(),
  }).strict(),
]);
export type AgentSpec = z.infer<typeof agentSpecSchema>;

const agentsFileSchema = z.object({ agents: z.array(agentSpecSchema) }).strict().superRefine((file, ctx) => {
  const seen = new Set<string>();
  for (const [i, spec] of file.agents.entries()) {
    if (seen.has(spec.id)) ctx.addIssue({ code: 'custom', path: ['agents', i, 'id'], message: `"${spec.id}" is used twice` });
    seen.add(spec.id);
    if (spec.type === 'openai' && spec.systemPrompt && spec.systemPromptFile) {
      ctx.addIssue({ code: 'custom', path: ['agents', i], message: 'use systemPrompt or systemPromptFile, not both' });
    }
  }
});

/** What the dashboard and `agents` command show for one agent. No secret values, only names. */
export interface AgentChoice {
  id: string;
  label: string;
  kind: 'builtin' | AgentSpec['type'];
  /** Environment variables that must be set before this agent can run. */
  requiredEnv: string[];
}

export interface AgentRegistry {
  /** The file custom agents came from, when there was one. */
  file?: string;
  specs: AgentSpec[];
}

export function parseAgentsFile(json: unknown, file?: string): AgentRegistry {
  const parsed = agentsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid agents file${file ? ` ${file}` : ''}: ${issues}`);
  }
  return { ...(file ? { file } : {}), specs: parsed.data.agents };
}

/**
 * Reads the agents file. A missing default file means no custom agents; a file named by
 * TRIPWIRE_AGENTS_FILE must exist, so a typo is not mistaken for "none registered".
 */
export function loadAgentRegistry(env: NodeJS.ProcessEnv, cwd = process.cwd()): AgentRegistry {
  const named = env.TRIPWIRE_AGENTS_FILE;
  const file = resolve(cwd, named || DEFAULT_AGENTS_FILE);
  if (!existsSync(file)) {
    if (named) throw new Error(`TRIPWIRE_AGENTS_FILE points to ${file}, which does not exist.`);
    return { specs: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read agents file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseAgentsFile(json, file);
}

function requiredEnvOf(spec: AgentSpec): string[] {
  if (spec.type === 'http') return spec.tokenEnv ? [spec.tokenEnv] : [];
  if (spec.type === 'openai') return spec.apiKeyEnv ? [spec.apiKeyEnv] : [];
  return [];
}

function labelOf(spec: AgentSpec): string {
  if (spec.label) return spec.label;
  if (spec.type === 'http') return `${spec.id} · deployed agent`;
  if (spec.type === 'openai') return `${spec.id} · ${spec.model}`;
  return `${spec.id} · local module`;
}

export function agentChoices(registry: AgentRegistry): AgentChoice[] {
  const xai = ['XAI_API_KEY', 'XAI_MODEL'];
  return [
    { id: 'grok', label: 'Grok', kind: 'builtin', requiredEnv: xai },
    { id: 'grok-careful', label: 'Grok · careful prompt', kind: 'builtin', requiredEnv: xai },
    { id: 'naive', label: 'Scripted · deterministic', kind: 'builtin', requiredEnv: [] },
    ...registry.specs.map((spec) => ({ id: spec.id, label: labelOf(spec), kind: spec.type, requiredEnv: requiredEnvOf(spec) })),
  ];
}

/**
 * Environment variables whose values must never appear in an event, report or recording.
 * The dashboard already hides *API_KEY / *SECRET / *PRIVATE_KEY; custom agents can name others.
 */
export function agentSecretEnv(registry: AgentRegistry): string[] {
  return registry.specs.flatMap(requiredEnvOf);
}

/** Builds the requested agent. Defaults to Grok when xAI is configured, else the scripted agent. */
export async function createAgent(requested: string | undefined, env: NodeJS.ProcessEnv, registry: AgentRegistry = loadAgentRegistry(env)): Promise<Agent> {
  const id = requested ?? (env.XAI_API_KEY && env.XAI_MODEL ? 'grok' : 'naive');
  if (id === 'naive') return new NaiveAgent();
  if (id === 'grok') return new GrokAgent({ model: env.XAI_MODEL, client: createXaiClient(env.XAI_API_KEY) });
  if (id === 'grok-careful') {
    return new GrokAgent({ model: env.XAI_MODEL, client: createXaiClient(env.XAI_API_KEY), systemPrompt: CAREFUL_SYSTEM_PROMPT, name: `grok-careful:${env.XAI_MODEL ?? ''}` });
  }
  const spec = registry.specs.find((s) => s.id === id);
  if (!spec) {
    const known = agentChoices(registry).map((c) => c.id).join(', ');
    throw new Error(`Unknown agent "${id}". Choose one of: ${known}${registry.file ? '' : ` (custom agents go in ${DEFAULT_AGENTS_FILE})`}`);
  }
  const missing = requiredEnvOf(spec).filter((key) => !env[key]);
  if (missing.length) throw new Error(`Agent "${id}" needs ${missing.join(', ')} set in .env.`);
  const base = registry.file ? dirname(registry.file) : process.cwd();

  if (spec.type === 'http') {
    return new RemoteAgent({
      url: spec.url,
      name: `${spec.id}:http`,
      ...(spec.tokenEnv ? { token: env[spec.tokenEnv] } : {}),
      ...(spec.maxSteps ? { maxSteps: spec.maxSteps } : {}),
      ...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
    });
  }
  if (spec.type === 'openai') {
    // Local servers such as Ollama take any key; the SDK insists on one being present.
    const apiKey = spec.apiKeyEnv ? env[spec.apiKeyEnv]! : 'not-needed';
    const systemPrompt = spec.systemPromptFile ? readFileSync(resolve(base, spec.systemPromptFile), 'utf8') : spec.systemPrompt;
    // GrokAgent is a plain tool-use loop over the OpenAI chat API; xAI is only its default endpoint.
    return new GrokAgent({
      client: new OpenAI({ apiKey, baseURL: spec.baseUrl }),
      model: spec.model,
      name: `${spec.id}:${spec.model}`,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(spec.maxSteps ? { maxSteps: spec.maxSteps } : {}),
    });
  }
  return loadModuleAgent(spec, base, env);
}

/**
 * A local TS/JS file exporting an Agent, or a function `(env) => Agent`. It runs inside this
 * process, so it could read .env or import the wallet: use it for your own code only.
 */
async function loadModuleAgent(spec: Extract<AgentSpec, { type: 'module' }>, base: string, env: NodeJS.ProcessEnv): Promise<Agent> {
  const file = resolve(base, spec.path);
  if (!existsSync(file)) throw new Error(`Agent "${spec.id}": module ${file} does not exist.`);
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  const exported = mod[spec.export ?? 'default'];
  const value = typeof exported === 'function' && !isAgent(exported) ? await (exported as (e: NodeJS.ProcessEnv) => unknown)(env) : exported;
  if (!isAgent(value)) {
    throw new Error(`Agent "${spec.id}": ${file} must export ${spec.export ? `"${spec.export}"` : 'a default'} Agent ({ name, run }) or a function returning one.`);
  }
  return value;
}

function isAgent(value: unknown): value is Agent {
  return typeof value === 'object' && value !== null && typeof (value as Agent).name === 'string' && typeof (value as Agent).run === 'function';
}
