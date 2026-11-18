import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { emit, type EventSink } from '../events.js';
import type { Agent, AgentResult, AgentTools, ToolCall } from '../types.js';
import { AgentRunError } from './errors.js';
import { TOOL_DEFS, executeTool } from './tools.js';

/**
 * The step protocol a user's own agent speaks, wherever it is deployed and whatever it is
 * written in. TripWire drives the loop: each step it POSTs the task, the tools and the
 * conversation so far; the agent answers with tool calls or a final message. TripWire runs
 * every tool call itself, through the guard, so the agent never sees a key or a signer and
 * never needs to reach back into TripWire. Documented in docs/BRING_YOUR_OWN_AGENT.md.
 */
export const REMOTE_PROTOCOL = 'tripwire.agent.v1';

/** One entry of the conversation sent with each step. Tool results are JSON strings. */
export type RemoteMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: { id: string; name: string; arguments: Record<string, unknown> }[] }
  | { role: 'tool'; tool_call_id: string; name: string; content: string };

export interface RemoteStepRequest {
  protocol: typeof REMOTE_PROTOCOL;
  /** Stable for one run of the agent (one scenario), so a stateful agent can key on it. */
  run_id: string;
  step: number;
  max_steps: number;
  task: string;
  tools: typeof TOOL_DEFS;
  messages: RemoteMessage[];
}

const toolCallSchema = z.object({
  id: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(64),
  // An object, or a JSON string of one (as OpenAI-style models produce).
  arguments: z.union([z.record(z.unknown()), z.string().max(64_000)]).optional(),
});

/** What the agent answers. Untrusted: validated before anything is run. */
export const remoteStepResponseSchema = z.object({
  message: z.string().max(16_000).nullish(),
  tool_calls: z.array(toolCallSchema).max(16).nullish(),
});
export type RemoteStepResponse = z.infer<typeof remoteStepResponseSchema>;

export interface RemoteAgentOptions {
  /** The agent's step endpoint. */
  url: string;
  name: string;
  /** Sent as `Authorization: Bearer <token>`, so the deployed endpoint can refuse strangers. */
  token?: string;
  maxSteps?: number;
  /** Per step. A slow model is fine; a hung endpoint must not hold the run forever. */
  timeoutMs?: number;
  /** More calls than this in one step are refused, not truncated, so nothing runs half a plan. */
  maxToolCallsPerStep?: number;
  fetchImpl?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 256 * 1024;

/** An agent the user deployed themselves, reached over HTTP with the step protocol. */
export class RemoteAgent implements Agent {
  readonly name: string;
  private readonly opts: Required<Omit<RemoteAgentOptions, 'token' | 'name'>> & { token?: string };

  constructor(opts: RemoteAgentOptions) {
    const url = new URL(opts.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Agent URL must be http(s): ${opts.url}`);
    this.name = opts.name;
    this.opts = {
      url: url.toString(),
      maxSteps: opts.maxSteps ?? 12,
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxToolCallsPerStep: opts.maxToolCallsPerStep ?? 8,
      fetchImpl: opts.fetchImpl ?? fetch,
      ...(opts.token ? { token: opts.token } : {}),
    };
  }

  async run(task: string, tools: AgentTools, onEvent?: EventSink): Promise<AgentResult> {
    const runId = randomUUID();
    const messages: RemoteMessage[] = [{ role: 'user', content: task }];
    const toolCalls: ToolCall[] = [];

    for (let step = 0; step < this.opts.maxSteps; step++) {
      emit(onEvent, { type: 'model.waiting', data: { step } });
      let reply: RemoteStepResponse;
      try {
        reply = await this.step({ protocol: REMOTE_PROTOCOL, run_id: runId, step, max_steps: this.opts.maxSteps, task, tools: TOOL_DEFS, messages });
      } catch (err) {
        // Earlier steps may already have paid someone, so the calls made so far go with the error.
        throw new AgentRunError(`The agent at ${this.opts.url} failed: ${err instanceof Error ? err.message : String(err)}`, toolCalls, { cause: err });
      }

      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) return { finalMessage: reply.message ?? '', toolCalls };
      if (calls.length > this.opts.maxToolCallsPerStep) {
        throw new AgentRunError(`The agent asked for ${calls.length} tool calls in one step; the limit is ${this.opts.maxToolCallsPerStep}.`, toolCalls);
      }

      const assistant: Extract<RemoteMessage, { role: 'assistant' }> = { role: 'assistant', content: reply.message ?? null, tool_calls: [] };
      const results: RemoteMessage[] = [];
      for (const [k, call] of calls.entries()) {
        const id = call.id ?? `call-${step}-${k}`;
        const args = parseArgs(call.arguments);
        assistant.tool_calls.push({ id, name: call.name, arguments: args ?? {} });
        const callId = randomUUID();
        emit(onEvent, { type: 'tool.started', data: { callId, name: call.name, args: args ?? call.arguments } });
        const result = args ? await executeTool(call.name, args, tools, this.opts.fetchImpl) : { error: 'Arguments were not a JSON object' };
        toolCalls.push({ name: call.name, args: args ?? call.arguments, result });
        emit(onEvent, { type: 'tool.completed', data: { callId, call: toolCalls.at(-1)! } });
        results.push({ role: 'tool', tool_call_id: id, name: call.name, content: JSON.stringify(result) });
      }
      messages.push(assistant, ...results);
    }
    return { finalMessage: `Stopped: reached the limit of ${this.opts.maxSteps} steps.`, toolCalls };
  }

  /** One round trip. Throws on transport errors, non-2xx answers and malformed replies. */
  async step(body: RemoteStepRequest): Promise<RemoteStepResponse> {
    const res = await this.opts.fetchImpl(this.opts.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tripwire-protocol': REMOTE_PROTOCOL,
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
      redirect: 'error',
    });
    const text = await readCapped(res, MAX_RESPONSE_BYTES);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`the reply was not JSON: ${text.slice(0, 200)}`);
    }
    const parsed = remoteStepResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`the reply did not match ${REMOTE_PROTOCOL}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  }
}

function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined) return {};
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw || '{}');
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Reads a body, refusing one larger than `limit` bytes instead of buffering it whole. */
async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`the reply was larger than ${limit} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
