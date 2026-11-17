import type { Address, TxHash } from './types.js';

export const ARC_TESTNET = {
  chainId: 5042002,
  name: 'Arc Testnet',
  /** Circle SDK blockchain identifier. Confirm against developers.circle.com. */
  circleBlockchain: 'ARC-TESTNET',
  defaultRpcUrl: 'https://rpc.testnet.arc.io',
  explorerUrl: 'https://testnet.arcscan.app',
  faucetUrl: 'https://faucet.circle.com',
} as const;

/** The real USDC on Arc: ERC-20 interface of the native gas token (6 decimals here, 18 natively). */
export const USDC_ADDRESS: Address = '0x3600000000000000000000000000000000000000';
export const USDC_DECIMALS = 6;

export const explorerTxUrl = (txHash: TxHash): string => `${ARC_TESTNET.explorerUrl}/tx/${txHash}`;

/** "1.50" -> 1500000n */
export function parseUsdc(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) throw new Error(`Invalid USDC amount: "${amount}"`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** 1500000n -> "1.5" */
export function formatUsdc(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / 1_000_000n}${frac ? `.${frac}` : ''}`;
}
