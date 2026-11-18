import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { executeTool, TOOL_DEFS } from '../agent/tools.js';
import type { AgentTools } from '../types.js';

/**
 * The guard as an MCP server, so any MCP client can pay through it: Claude Desktop, Claude
 * Code, Cursor, or a Python agent through an MCP adapter. The agent gets the same four tools
 * the built-in Grok agent has, and every payment still goes through the guard.
 *
 * Transport is stdio: one JSON-RPC 2.0 message per line. Only the handful of methods a tool
 * server needs are implemented, so there is no SDK dependency.
 */

/** Protocol revisions this server speaks, newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

const SERVER_INFO = { name: 'tripwire-guard', version: '0.1.0' };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type Id = string | number;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: Id | null;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: Id | null; result: unknown }
  | { jsonrpc: '2.0'; id: Id | null; error: { code: number; message: string } };

export interface McpServerOptions {
  tools: AgentTools;
  /** Shown to the agent when it connects, e.g. where the merchant is. */
  instructions?: string;
  /** Used by merchant_request. Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** The tool list as MCP describes it: the same names and schemas the built-in agent uses. */
export const MCP_TOOLS = TOOL_DEFS.map((def) => ({
  name: def.function.name,
  description: def.function.description ?? '',
  inputSchema: def.function.parameters ?? { type: 'object', properties: {} },
}));

const KNOWN_TOOLS = new Set(MCP_TOOLS.map((t) => t.name));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ok = (id: Id | null, result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
const fail = (id: Id | null, code: number, message: string): JsonRpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

const isRequest = (msg: unknown): msg is JsonRpcRequest =>
  isRecord(msg) &&
  msg.jsonrpc === '2.0' &&
  typeof msg.method === 'string' &&
  (msg.params === undefined || isRecord(msg.params)) &&
  (msg.id === undefined || msg.id === null || typeof msg.id === 'string' || typeof msg.id === 'number');

/**
 * Answers one parsed message. Returns undefined for notifications, which get no reply.
 * A tool that fails (bad arguments, a denied payment's error) is reported inside the
 * result with `isError`, so the agent can read why and react, as MCP intends.
 */
export async function handleMessage(msg: unknown, opts: McpServerOptions): Promise<JsonRpcResponse | undefined> {
  if (!isRequest(msg)) {
    const id = isRecord(msg) && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    return fail(id, INVALID_REQUEST, 'Not a JSON-RPC 2.0 request.');
  }
  const { method, params = {} } = msg;
  if (msg.id === undefined || msg.id === null) return undefined; // a notification, e.g. notifications/initialized
  const id = msg.id;

  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || !KNOWN_TOOLS.has(name)) return fail(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`);
      const args = isRecord(params.arguments) ? params.arguments : {};
      const result = await executeTool(name, args, opts.tools, opts.fetchImpl);
      const isError = isRecord(result) && 'error' in result;
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError });
    }
    default:
      return fail(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** Answers one line of input. Returns the reply line, or undefined when there is nothing to send. */
export async function handleLine(line: string, opts: McpServerOptions): Promise<string | undefined> {
  if (!line.trim()) return undefined;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return JSON.stringify(fail(null, PARSE_ERROR, 'Invalid JSON.'));
  }
  const reply = await handleMessage(msg, opts);
  return reply === undefined ? undefined : JSON.stringify(reply);
}

/**
 * Serves MCP over stdio until the input closes. Requests are answered as they finish, so a
 * payment waiting for the owner's approval does not hold up a balance check.
 * Nothing but protocol messages may go to `output`: log to stderr.
 */
export function serveStdio(
  opts: McpServerOptions,
  io: { input: Readable; output: Writable } = { input: process.stdin, output: process.stdout },
): Promise<void> {
  const lines = createInterface({ input: io.input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  lines.on('line', (line) => {
    const task = handleLine(line, opts)
      .then((reply) => {
        if (reply !== undefined) io.output.write(`${reply}\n`);
      })
      .catch((err: unknown) => {
        process.stderr.write(`tripwire-guard: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  return new Promise((resolve) => {
    lines.on('close', () => {
      void Promise.all(pending).then(() => resolve());
    });
  });
}
