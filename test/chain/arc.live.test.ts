import { parseAbiItem } from 'viem';
import { describe, expect, it } from 'vitest';
import { ArcChainReader, createArcClient } from '../../src/chain/arc.js';
import { ARC_TESTNET, USDC_ADDRESS } from '../../src/constants.js';

/**
 * Read-only checks against the real Arc Testnet RPC. No keys needed.
 * Skipped by default; run with:  LIVE=1 npm test
 */
describe.skipIf(!process.env.LIVE)('ArcChainReader (live)', () => {
  const client = createArcClient();
  const reader = new ArcChainReader(client);

  it('talks to Arc Testnet', async () => {
    expect(await client.getChainId()).toBe(ARC_TESTNET.chainId);
  });

  it('parses a real USDC transfer and reads a balance', async () => {
    const head = await client.getBlockNumber();
    const logs = await client.getLogs({
      address: USDC_ADDRESS,
      event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
      fromBlock: head - 20n,
      toBlock: head,
    });
    expect(logs.length).toBeGreaterThan(0);
    const log = logs[0]!;

    const tx = await reader.getTx(log.transactionHash);
    expect(tx?.status).toBe('success');
    expect(tx!.confirmations).toBeGreaterThanOrEqual(1);
    expect(tx!.transfers).toContainEqual({
      token: USDC_ADDRESS,
      from: log.args.from!.toLowerCase(),
      to: log.args.to!.toLowerCase(),
      value: log.args.value,
    });

    expect(await reader.getUsdcBalance(log.args.to!)).toBeGreaterThanOrEqual(0n);
  }, 30_000);

  it('returns null for a hash that does not exist or is malformed', async () => {
    expect(await reader.getTx(`0x${'dead'.repeat(16)}`)).toBeNull();
    expect(await reader.getTx('0x1234')).toBeNull();
  }, 30_000);
});
