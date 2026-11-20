import { describe, expect, it } from 'vitest';
import { parseUsdc } from '../../src/constants.js';
import {
  DEMO_STREAMS_DIR,
  REQUIRED_KEYS,
  cloudflaredCheck,
  envChecks,
  gatewayCheck,
  monitorCheck,
  nodeCheck,
  renderChecks,
  replayCheck,
  streamProgress,
  tunnelUrlIn,
} from '../../src/demo/checks.js';

const fullEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(REQUIRED_KEYS.map((k) => [k, 'x'])),
  QUICKNODE_API_KEY: 'q',
  QUICKNODE_STREAMS_ENABLED: 'true',
  QUICKNODE_STREAMS_DATA_DIR: DEMO_STREAMS_DIR,
  FAKE_USDC_ADDRESS: '0xabc',
});
const envText = `CIRCLE_API_KEY=x\nQUICKNODE_STREAMS_DATA_DIR=${DEMO_STREAMS_DIR}\n`;
const byName = (results: ReturnType<typeof envChecks>, name: string) => results.find((r) => r.name === name)!;

describe('demo preflight checks', () => {
  it('a complete team .env passes', () => {
    expect(envChecks(fullEnv(), envText).every((r) => r.status === 'ok')).toBe(true);
  });

  it('no .env is one failure that says how to get it, never over chat or Git', () => {
    const [only, ...rest] = envChecks({}, undefined);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ name: '.env', status: 'fail' });
    expect(only!.fix).toMatch(/AirDrop/);
  });

  it('names missing keys', () => {
    const env = fullEnv();
    delete env.XAI_API_KEY;
    delete env.QUICKNODE_API_KEY;
    const results = envChecks(env, envText);
    expect(byName(results, 'Circle, wallet and Grok keys')).toMatchObject({ status: 'fail', detail: 'missing XAI_API_KEY' });
    expect(byName(results, 'QuickNode key').status).toBe('fail');
  });

  it('a duplicated QUICKNODE_STREAMS_DATA_DIR fails; another directory only warns', () => {
    const twice = `QUICKNODE_STREAMS_DATA_DIR=.data/streams\nQUICKNODE_STREAMS_DATA_DIR=${DEMO_STREAMS_DIR}\n`;
    expect(byName(envChecks(fullEnv(), twice), 'Streams data directory')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/2 times/) });
    const other = { ...fullEnv(), QUICKNODE_STREAMS_DATA_DIR: '.data/streams' };
    expect(byName(envChecks(other, 'QUICKNODE_STREAMS_DATA_DIR=.data/streams\n'), 'Streams data directory').status).toBe('warn');
  });

  it('streams disabled is a warning', () => {
    expect(byName(envChecks({ ...fullEnv(), QUICKNODE_STREAMS_ENABLED: 'false' }, envText), 'Streams monitoring').status).toBe('warn');
  });

  it('tools, balance, monitor and recordings', () => {
    expect(nodeCheck('v22.1.0').status).toBe('ok');
    expect(nodeCheck('v18.19.0').status).toBe('fail');
    expect(cloudflaredCheck(undefined)).toMatchObject({ status: 'fail', fix: 'brew install cloudflared' });
    expect(gatewayCheck(parseUsdc('1.1')).status).toBe('ok');
    expect(gatewayCheck(parseUsdc('0.5'))).toMatchObject({ status: 'fail', fix: expect.stringMatching(/gateway:deposit/) });
    expect(gatewayCheck(undefined, 'offline').status).toBe('warn');
    expect(monitorCheck(123, true).status).toBe('warn');
    expect(monitorCheck(123, false).status).toBe('ok');
    expect(replayCheck(undefined).status).toBe('fail');
  });

  it('renders a verdict line', () => {
    expect(renderChecks([nodeCheck('v22.0.0')]).at(-1)).toBe('Ready for the live demo.');
    expect(renderChecks([nodeCheck('v18.0.0'), gatewayCheck(undefined)]).at(-1)).toBe('1 problem(s) to fix before a live demo, 1 warning(s).');
  });
});

describe('live demo helpers', () => {
  it('finds the quick tunnel URL in cloudflared output', () => {
    expect(tunnelUrlIn('2026-11-20T04:00:00Z INF |  https://shy-river-1234.trycloudflare.com                    |')).toBe('https://shy-river-1234.trycloudflare.com');
    expect(tunnelUrlIn('INF Registered tunnel connection connIndex=0')).toBeUndefined();
    expect(tunnelUrlIn('see https://www.cloudflare.com/website-terms/')).toBeUndefined();
  });

  it('reports backfill progress', () => {
    expect(streamProgress({ ready: true, coveredThrough: 10 })).toBe('ready');
    expect(streamProgress({ ready: false, reason: 'Stream backfill is incomplete', startBlock: 1000, liveBoundary: 1999, coveredThrough: 1499 })).toBe(
      'Stream backfill is incomplete: block 1499 of 1999 (50% of the backfill)',
    );
    expect(streamProgress({ ready: false, reason: 'Stream not configured', coveredThrough: -1 })).toBe('Stream not configured');
  });
});
