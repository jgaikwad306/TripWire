import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentChoices, agentSecretEnv, createAgent, loadAgentRegistry, parseAgentsFile } from '../../src/agent/registry.js';
import { RemoteAgent } from '../../src/agent/remote.js';
import { GrokAgent } from '../../src/agent/grok.js';
import { NaiveAgent } from '../../src/redteam/naive-agent.js';
import { RunManager, missingConfiguration } from '../../src/dashboard/manager.js';
import { agentsCommand } from '../../src/agent/commands.js';

const remote = { id: 'mine', type: 'http', url: 'http://127.0.0.1:9/step', tokenEnv: 'MINE_TOKEN' } as const;

describe('agent registry (agents.json)', () => {
  it('rejects bad entries with a message naming the field', () => {
    expect(() => parseAgentsFile({ agents: [{ ...remote, id: 'Bad Id' }] })).toThrow(/agents\.0\.id/);
    expect(() => parseAgentsFile({ agents: [{ ...remote, id: 'grok' }] })).toThrow(/built-in/);
    expect(() => parseAgentsFile({ agents: [remote, remote] })).toThrow(/used twice/);
    expect(() => parseAgentsFile({ agents: [{ ...remote, tokenEnv: 'sk-live-123' }] })).toThrow(/environment variable name/);
    // Secrets go in .env: an inline key is an unknown field, not silently accepted.
    expect(() => parseAgentsFile({ agents: [{ ...remote, token: 'sk-live-123' }] })).toThrow(/token/);
    expect(() => parseAgentsFile({ agents: [{ id: 'o', type: 'openai', baseUrl: 'http://x', model: 'm', systemPrompt: 'a', systemPromptFile: 'b' }] })).toThrow(/not both/);
  });

  it('treats a missing default file as no custom agents, but a missing named file as an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-agents-'));
    expect(loadAgentRegistry({}, dir)).toEqual({ specs: [] });
    expect(() => loadAgentRegistry({ TRIPWIRE_AGENTS_FILE: 'nope.json' }, dir)).toThrow(/does not exist/);
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({ agents: [remote] }));
    expect(loadAgentRegistry({}, dir).specs.map((s) => s.id)).toEqual(['mine']);
  });

  it('lists built-in and custom agents with the env they need, and which values to redact', () => {
    const registry = parseAgentsFile({ agents: [remote] });
    const choices = agentChoices(registry);
    expect(choices.map((c) => c.id)).toEqual(['grok', 'grok-careful', 'naive', 'mine']);
    expect(choices.find((c) => c.id === 'mine')).toMatchObject({ kind: 'http', requiredEnv: ['MINE_TOKEN'] });
    expect(agentSecretEnv(registry)).toEqual(['MINE_TOKEN']);
  });

  it('builds each kind of agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-agents-'));
    writeFileSync(join(dir, 'prompt.txt'), 'Be careful.');
    writeFileSync(join(dir, 'agent.mjs'), "export default (env) => ({ name: 'mod:' + env.FLAVOUR, run: async () => ({ finalMessage: 'hi', toolCalls: [] }) });");
    const registry = { file: join(dir, 'agents.json'), ...parseAgentsFile({ agents: [
      remote,
      { id: 'llama', type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', systemPromptFile: 'prompt.txt' },
      { id: 'mod', type: 'module', path: 'agent.mjs' },
    ] }) };

    expect(await createAgent('naive', {}, registry)).toBeInstanceOf(NaiveAgent);
    await expect(createAgent('mine', {}, registry)).rejects.toThrow(/needs MINE_TOKEN/);
    const http = await createAgent('mine', { MINE_TOKEN: 't' }, registry);
    expect(http).toBeInstanceOf(RemoteAgent);
    expect(http.name).toBe('mine:http');
    const llama = await createAgent('llama', {}, registry);
    expect(llama).toBeInstanceOf(GrokAgent);
    expect(llama.name).toBe('llama:llama3.1');
    expect((await createAgent('mod', { FLAVOUR: 'vanilla' }, registry)).name).toBe('mod:vanilla');
    await expect(createAgent('ghost', {}, registry)).rejects.toThrow(/Unknown agent "ghost"/);
  });

  it('rejects a module that does not export an agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-agents-'));
    writeFileSync(join(dir, 'bad.mjs'), 'export default 42;');
    const registry = { file: join(dir, 'agents.json'), ...parseAgentsFile({ agents: [{ id: 'bad', type: 'module', path: 'bad.mjs' }] }) };
    await expect(createAgent('bad', {}, registry)).rejects.toThrow(/must export/);
  });
});

describe('dashboard with custom agents', () => {
  const registry = parseAgentsFile({ agents: [remote] });

  it('offers them, checks their env before a run, and refuses unknown agents', () => {
    const manager = new RunManager({ env: {}, registry, outDir: mkdtempSync(join(tmpdir(), 'tripwire-dash-')) });
    const config = manager.config();
    expect(config.agents.map((a) => a.id)).toContain('mine');
    expect(config.configured).toHaveProperty('MINE_TOKEN', false);
    const run = { scenarioIds: ['api-research'], network: 'fake' as const, agent: 'mine' };
    expect(missingConfiguration(run, {}, manager.agents)).toEqual(['MINE_TOKEN']);
    expect(() => manager.start(run)).toThrow(/MINE_TOKEN/);
    expect(() => manager.start({ ...run, agent: 'ghost' })).toThrow(/Unknown agent "ghost"/);
  });

  it('never publishes a custom agent token, even under a name the default filter misses', async () => {
    const manager = new RunManager({
      env: { MINE_TOKEN: 'tok-abc123' }, registry, outDir: mkdtempSync(join(tmpdir(), 'tripwire-dash-')), record: false,
      execute: async (opts) => { opts.io.log('agent said tok-abc123'); throw new Error('stop here'); },
    });
    manager.start({ scenarioIds: ['api-research'], network: 'fake', agent: 'mine' });
    await manager.close();
    const text = JSON.stringify(manager.run!.events);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('tok-abc123');
  });
});

describe('agents command', () => {
  it('lists agents and what they still need', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tripwire-agents-'));
    const file = join(dir, 'agents.json');
    writeFileSync(file, JSON.stringify({ agents: [remote] }));
    const lines: string[] = [];
    await agentsCommand([], { env: { TRIPWIRE_AGENTS_FILE: file }, log: (l) => lines.push(l) });
    expect(lines.join('\n')).toMatch(/mine\s+http\s+.*needs MINE_TOKEN/);
    expect(lines.join('\n')).toMatch(/naive\s+builtin\s+.*ready/);
  });
});
