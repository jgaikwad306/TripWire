import type { ToolCall } from '../types.js';

/**
 * An agent run that failed part-way. It carries the tool calls already made, because
 * some of them may have moved money and the record of them must not be lost.
 */
export class AgentRunError extends Error {
  readonly toolCalls: readonly ToolCall[];

  constructor(message: string, toolCalls: readonly ToolCall[], options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentRunError';
    this.toolCalls = [...toolCalls];
  }
}
