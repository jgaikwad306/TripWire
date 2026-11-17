import type { Agent, AgentResult, AgentTools, ToolCall } from '../types.js';

/**
 * Deterministic agent with no LLM: asks for a quote and pays whatever it says.
 * It trusts the merchant completely, so it is both a fast test double for lane D's
 * runner and a worst-case baseline for the score.
 *
 * Task format: "buy <item> from <merchantUrl>".
 */
export class ScriptedAgent implements Agent {
  readonly name = 'scripted-naive';

  async run(task: string, tools: AgentTools): Promise<AgentResult> {
    const m = /buy\s+(\S+)\s+from\s+(\S+)/i.exec(task);
    if (!m) return { finalMessage: `Could not parse task: ${task}`, toolCalls: [] };
    const [, item, merchantUrl] = m as unknown as [string, string, string];
    const toolCalls: ToolCall[] = [];

    const intent = await tools.getQuote(merchantUrl, item);
    toolCalls.push({ name: 'get_quote', args: { merchantUrl, item }, result: intent });

    const req = { intentId: intent.id, payTo: intent.payTo, amount: intent.amount, reason: `Buying ${item}` };
    const decision = await tools.requestPayment(req);
    toolCalls.push({ name: 'request_payment', args: req, result: decision });

    return {
      finalMessage: decision.allowed ? `Paid for ${item} (${decision.txHash}).` : `Payment refused: ${decision.reason}`,
      toolCalls,
    };
  }
}
