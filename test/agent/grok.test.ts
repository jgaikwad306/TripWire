import type OpenAI from 'openai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GrokAgent, type ChatClient } from '../../src/agent/grok.js';
import { executeTool, unguardedTools } from '../../src/agent/tools.js';
import { parseUsdc } from '../../src/constants.js';
import { AllowAllGuard, FAKE_ADDRESSES, FakeLedger } from '../../src/fakes/index.js';
import { LocalFacilitator } from '../../src/x402/facilitator.js';
import { httpQuoteFetcher } from '../../src/merchant/quote.js';
import { startMerchant, type MockMerchant } from '../../src/merchant/server.js';

type Body = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type Reply = string | { name: string; args: unknown }[];

/** A scripted model: each step sees the conversation so far and answers with text or tool calls. */
function scriptedClient(steps: ((body: Body) => Reply)[]) {
  const seen: Body[] = [];
  let i = 0;
  const client: ChatClient = {
    chat: {
      completions: {
        create: async (body) => {
          seen.push(structuredClone(body));
          const reply = steps[Math.min(i, steps.length - 1)]!(body);
          const n = i++;
          const message =
            typeof reply === 'string'
              ? { role: 'assistant', content: reply }
              : {
                  role: 'assistant',
                  content: null,
                  tool_calls: reply.map((c, k) => ({
                    id: `call-${n}-${k}`,
                    type: 'function',
                    function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) },
                  })),
                };
          return { choices: [{ index: 0, message, finish_reason: 'stop' }] } as unknown as OpenAI.Chat.Completions.ChatCompletion;
        },
      },
    },
  };
  return { client, seen };
}

/** Result of the most recent tool call, as the model would read it. */
const lastToolResult = (body: Body): Record<string, any> => {
  const last = body.messages[body.messages.length - 1]!;
  if (last.role !== 'tool') throw new Error('Expected a tool message');
  return JSON.parse(last.content as string);
};

let merchant: MockMerchant;
let ledger: FakeLedger;

beforeAll(async () => {
  merchant = await startMerchant({
    payTo: FAKE_ADDRESSES.merchant,
    attacker: FAKE_ADDRESSES.attacker,
    prices: { report: parseUsdc('0.5') },
    // Settles x402 payments on whichever ledger the current test uses, through the official facilitator.
    acceptPayment: (req) =>
      new AllowAllGuard(ledger, httpQuoteFetcher, { facilitator: new LocalFacilitator(ledger.facilitatorSigner()) }).acceptPayment(req),
  });
});
afterAll(() => merchant.close());
beforeEach(() => {
  merchant.reset();
  ledger = new FakeLedger({ hot: parseUsdc('10') });
});

/** A model that does exactly what the merchant's payment request says. */
const obedientBuyer = (url: string): ((body: Body) => Reply)[] => {
  let intentId = '';
  return [
    () => [{ name: 'get_quote', args: { merchant_url: url, item: 'report' } }],
    (b) => {
      intentId = lastToolResult(b).intent_id;
      return [{ name: 'merchant_request', args: { merchant_url: url, method: 'POST', path: '/buy', body: { item: 'report' } } }];
    },
    (b) => {
      const ask = lastToolResult(b).body;
      return [
        {
          name: 'request_payment',
          args: { intent_id: intentId, pay_to: ask.payTo, amount_usdc: (Number(ask.amount) / 1e6).toString(), reason: 'report' },
        },
      ];
    },
    // Paying over x402 brings the goods back with the payment.
    (b) => (lastToolResult(b).merchant_response?.body?.delivered ? 'Bought the report.' : 'The purchase failed.'),
  ];
};

describe('GrokAgent', () => {
  it('completes an honest purchase end to end over HTTP', async () => {
    const { client, seen } = scriptedClient(obedientBuyer(merchant.url));
    const agent = new GrokAgent({ client, model: 'test-model' });
    const { tools } = unguardedTools(ledger, httpQuoteFetcher, { chain: ledger });

    const result = await agent.run(`Buy one "report" from ${merchant.url}.`, tools);

    expect(result.finalMessage).toBe('Bought the report.');
    expect(result.toolCalls.map((c) => c.name)).toEqual(['get_quote', 'merchant_request', 'request_payment']);
    expect(await ledger.getBalance('merchant')).toBe(parseUsdc('0.5'));
    expect(merchant.deliveries()).toHaveLength(1);
    expect(seen[0]).toMatchObject({ model: 'test-model' });
    expect(seen[0]!.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(seen[0]!.tools!.length).toBe(5);
  });

  it('without a guard, an obedient model pays the attacker on swap-payto', async () => {
    merchant.setMode('swap-payto');
    const agent = new GrokAgent({ client: scriptedClient(obedientBuyer(merchant.url)).client, model: 'm' });
    const { tools, guard } = unguardedTools(ledger, httpQuoteFetcher);
    await agent.run('buy', tools);

    expect(await ledger.getBalance('attacker')).toBe(parseUsdc('0.5'));
    expect(await ledger.getBalance('merchant')).toBe(0n);
    expect(guard.decisions()).toHaveLength(1);
  });

  it('stops at the step limit when the model keeps paying in a retry loop', async () => {
    merchant.setMode('retry-loop');
    const pay = { name: 'request_payment', args: { intent_id: 'x', pay_to: FAKE_ADDRESSES.merchant, amount_usdc: '0.5', reason: 'retry' } };
    const agent = new GrokAgent({ client: scriptedClient([() => [pay]]).client, model: 'm', maxSteps: 4 });
    const result = await agent.run('buy', unguardedTools(ledger, httpQuoteFetcher).tools);

    expect(result.finalMessage).toMatch(/limit of 4 steps/);
    expect(result.toolCalls).toHaveLength(4);
    expect(await ledger.getBalance('merchant')).toBe(parseUsdc('2'));
  });

  it('feeds bad tool calls back to the model as errors instead of crashing', async () => {
    const { client, seen } = scriptedClient([
      () => [
        { name: 'request_payment', args: '{not json' },
        { name: 'request_payment', args: { intent_id: 'x', pay_to: 'bob', amount_usdc: '1', reason: '' } },
        { name: 'request_payment', args: { intent_id: 'x', pay_to: FAKE_ADDRESSES.merchant, amount_usdc: 'lots', reason: '' } },
        { name: 'launch_rocket', args: {} },
      ],
      () => 'Gave up.',
    ]);
    const result = await new GrokAgent({ client, model: 'm' }).run('buy', unguardedTools(ledger, httpQuoteFetcher).tools);

    expect(result.finalMessage).toBe('Gave up.');
    expect(result.toolCalls.map((c) => (c.result as { error: string }).error)).toEqual([
      'Arguments were not valid JSON',
      'pay_to is not a valid address',
      'Invalid USDC amount: "lots"',
      'Unknown tool: launch_rocket',
    ]);
    expect(seen[1]!.messages.filter((m) => m.role === 'tool')).toHaveLength(4);
    expect(await ledger.getBalance('hot')).toBe(parseUsdc('10'));
  });

  it('requires a model name', () => {
    const saved = process.env.XAI_MODEL;
    delete process.env.XAI_MODEL;
    expect(() => new GrokAgent({ client: scriptedClient([]).client })).toThrow(/XAI_MODEL/);
    if (saved !== undefined) process.env.XAI_MODEL = saved;
  });
});

describe('executeTool', () => {
  it('reports balance as decimal USDC and refuses non-http URLs', async () => {
    const { tools } = unguardedTools(ledger, httpQuoteFetcher);
    expect(await executeTool('check_balance', {}, tools)).toEqual({ balance_usdc: '10' });
    expect(await executeTool('merchant_request', { merchant_url: 'file:///etc', method: 'GET', path: 'passwd' }, tools)).toEqual({
      error: 'Only http(s) URLs are allowed',
    });
  });
});
