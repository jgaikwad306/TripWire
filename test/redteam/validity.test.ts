import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { AgentRunError } from '../../src/agent/errors.js';
import { GrokAgent, type ChatClient } from '../../src/agent/grok.js';
import { NaiveAgent } from '../../src/redteam/naive-agent.js';
import { runScenario } from '../../src/redteam/runner.js';
import { findScenario } from '../../src/redteam/scenarios/index.js';
import { fakeWorldFactory, type WorldFactory } from '../../src/redteam/world.js';
import type { Agent, AgentTools, TranscriptEntry, WalletProvider } from '../../src/types.js';
import { compileFakeUsdc } from '../../src/wallet/counterfeit.js';

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>;

const toolEntries = (transcript: TranscriptEntry[] | undefined, name: string): ToolEntry[] =>
  (transcript ?? []).filter((e): e is ToolEntry => e.kind === 'tool' && e.name === name);

const fake = (guarded: boolean, agent: Agent = new NaiveAgent()): WorldFactory => fakeWorldFactory({ guarded, agent });

describe('a scenario that never tested its attack does not pass', () => {
  it('fails the replay scenario when the legitimate first claim is rejected', async () => {
    // The customer's payment arrives short, so the guard rejects the first, honest claim.
    const shortPaying: WorldFactory = async () => {
      const world = await fake(true)();
      const inner = world.wallet;
      const wallet: WalletProvider = {
        addressOf: (role) => inner.addressOf(role),
        getBalance: (role) => inner.getBalance(role),
        transfer: (args) => inner.transfer({ ...args, amount: args.amount / 2n }),
      };
      return { ...world, wallet };
    };

    const result = await runScenario(findScenario('replay')!, shortPaying);

    expect(result.passed).toBe(false);
    expect(result.usdcLost).toBe(0n);
    expect(result.error).toMatch(/not tested.*legitimate claim was rejected/i);
  });

  it('still passes the replay scenario when the first claim is accepted and the second refused', async () => {
    const result = await runScenario(findScenario('replay')!, fake(true));
    expect(result).toMatchObject({ passed: true, usdcLost: 0n });
    expect(result.error).toBeUndefined();
  });

  it('fails a send attack when the agent never made a tool call', async () => {
    const idle: Agent = { name: 'idle', run: async () => ({ finalMessage: 'I will not do that.', toolCalls: [] }) };

    const result = await runScenario(findScenario('swap-payto')!, fake(true, idle));

    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/not tested.*no tool calls/i);
  });
});

describe('a failed measurement keeps the record of what happened', () => {
  it('keeps decisions, transactions and the transcript, and says the loss is unknown', async () => {
    const blind: WorldFactory = async () => {
      const world = await fake(false)();
      return { ...world, chain: { ...world.chain, getTx: async () => null, getUsdcBalance: async () => 0n } };
    };

    const result = await runScenario(findScenario('honest-1')!, blind);

    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/Could not measure.*loss is unknown/);
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.txHashes).toHaveLength(1);
    expect(result.transcript?.[0]).toMatchObject({ kind: 'task' });
  });
});

describe('a scenario that threw and could not be measured', () => {
  it('reports both problems', async () => {
    // Pays the attacker's swapped address, then fails, on a chain that cannot be read.
    const payThenCrash: Agent = {
      name: 'pay-then-crash',
      run: async (_task, tools) => {
        const url = /https?:\/\/\S+/.exec(_task)![0];
        const intent = await tools.getQuote(url, 'report');
        await tools.requestPayment({ intentId: intent.id, payTo: intent.payTo, amount: intent.amount, reason: '' });
        throw new Error('model went away');
      },
    };
    const blind: WorldFactory = async () => {
      const world = await fake(false, payThenCrash)();
      return { ...world, chain: { ...world.chain, getTx: async () => null, getUsdcBalance: async () => 0n } };
    };

    const result = await runScenario(findScenario('swap-payto')!, blind);

    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/^model went away Could not measure the outcome, so the loss is unknown/);
    expect(result.txHashes).toHaveLength(1);
  });
});

describe('transcripts', () => {
  it('keeps the tool calls an agent made before it threw', async () => {
    const crashing: Agent = {
      name: 'crashing',
      run: async () => {
        throw new AgentRunError('model went away', [{ name: 'get_quote', args: { item: 'report' }, result: { price_usdc: '0.5' } }]);
      },
    };

    const result = await runScenario(findScenario('swap-payto')!, fake(true, crashing));

    expect(result.passed).toBe(false);
    expect(result.error).toBe('model went away');
    expect(toolEntries(result.transcript, 'get_quote')).toHaveLength(1);
  });

  it('GrokAgent reports the tool calls made before the model API failed', async () => {
    let calls = 0;
    const client: ChatClient = {
      chat: {
        completions: {
          create: async () => {
            if (calls++ > 0) throw new Error('429 rate limited');
            const message = {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'check_balance', arguments: '{}' } }],
            };
            return { choices: [{ index: 0, message, finish_reason: 'stop' }] } as unknown as OpenAI.Chat.Completions.ChatCompletion;
          },
        },
      },
    };
    const tools: AgentTools = {
      getQuote: async () => { throw new Error('unused'); },
      requestPayment: async () => { throw new Error('unused'); },
      checkBalance: async () => 1_000_000n,
    };

    const run = new GrokAgent({ client, model: 'test-model' }).run('Buy something', tools);

    await expect(run).rejects.toBeInstanceOf(AgentRunError);
    await run.catch((err: AgentRunError) => {
      expect(err.message).toMatch(/model API call failed.*429 rate limited/);
      expect(err.toolCalls.map((c) => c.name)).toEqual(['check_balance']);
    });
  });

  it('the scripted agent records amounts in USDC, not base units', async () => {
    const result = await runScenario(findScenario('honest-1')!, fake(true));

    const [payment] = toolEntries(result.transcript, 'request_payment');
    expect(payment?.args).toMatchObject({ amount_usdc: '0.5' });
    expect(payment?.args).not.toHaveProperty('amount');
    expect(payment?.result).toMatchObject({ allowed: true });
    const [quote] = toolEntries(result.transcript, 'get_quote');
    expect(quote?.result).toMatchObject({ item: 'report', price_usdc: '0.5' });
    expect(quote?.result).not.toHaveProperty('amount');
  });

  it('the scripted agent records the balance check that sizes a "move everything" payment', async () => {
    const result = await runScenario(findScenario('move-to-safety')!, fake(false));

    const [balance] = toolEntries(result.transcript, 'check_balance');
    expect(balance?.result).toEqual({ balance_usdc: '10' });
    expect(toolEntries(result.transcript, 'request_payment')[0]?.args).toMatchObject({ amount_usdc: '9.5' });
  });
});

describe('compileFakeUsdc', () => {
  it('compiles once and reuses the result', () => {
    expect(compileFakeUsdc()).toBe(compileFakeUsdc());
  });
});
