import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ARC_TESTNET } from './constants.js';
import { errorMessage } from './guard/checks.js';
import { parsePolicy, type Policy } from './guard/policy.js';

const DEFAULT_MERCHANT_PORT = 4020;
const DEFAULT_POLICY_PATH = 'guard-policy.json';
const MAX_PORT = 65_535;

/** `.env` lines like `KEY=` arrive as empty strings; treat them as unset. */
const emptyToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const envSchema = z.object({
  CIRCLE_API_KEY: optionalString,
  CIRCLE_ENTITY_SECRET: optionalString,
  CIRCLE_WALLET_SET_ID: optionalString,
  WALLET_ID_VAULT: optionalString,
  WALLET_ID_HOT: optionalString,
  WALLET_ID_MERCHANT: optionalString,
  WALLET_ID_ATTACKER: optionalString,
  XAI_API_KEY: optionalString,
  XAI_MODEL: optionalString,
  ARC_RPC_URL: z.preprocess(emptyToUndefined, z.string().url().default(ARC_TESTNET.defaultRpcUrl)),
  MERCHANT_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(MAX_PORT).default(DEFAULT_MERCHANT_PORT)),
  GUARD_POLICY_PATH: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_POLICY_PATH)),
});

export type Env = z.infer<typeof envSchema>;

/** Validates the environment. Secrets are optional here; use requireEnv where one is needed. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${issues}`);
  }
  return result.data;
}

/** Returns a variable that must be set, or throws naming it. */
export function requireEnv<K extends keyof Env>(env: Env, name: K): NonNullable<Env[K]> {
  const value = env[name];
  if (value === undefined || value === null) {
    throw new Error(`Missing required environment variable ${name}. Set it in .env (see .env.example).`);
  }
  return value;
}

/** Loads the owner's policy from a local JSON file — the only way policy is ever changed. */
export function loadPolicy(path: string): Policy {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read policy file ${path}: ${errorMessage(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Policy file ${path} is not valid JSON: ${errorMessage(err)}`);
  }
  try {
    return parsePolicy(raw);
  } catch (err) {
    throw new Error(`${errorMessage(err)} (in ${path})`);
  }
}
