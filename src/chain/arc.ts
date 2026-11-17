import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  defineChain,
  http,
  parseAbi,
  type PublicClient,
} from 'viem';
import { ARC_TESTNET, USDC_ADDRESS } from '../constants.js';
import type { Address, ChainReader, TokenTransfer, TxHash, TxInfo, Usdc } from '../types.js';

export const arcTestnet = defineChain({
  id: ARC_TESTNET.chainId,
  name: ARC_TESTNET.name,
  // Gas is paid in USDC, which has 18 decimals as the native token (6 through the ERC-20 interface).
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET.defaultRpcUrl] } },
  blockExplorers: { default: { name: 'Arcscan', url: ARC_TESTNET.explorerUrl } },
  testnet: true,
});

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);
/** Public Arc nodes refuse log queries over 10,000 blocks, so the search goes back in windows. */
const LOG_WINDOW_BLOCKS = 5_000n;
/** About 14 hours of Arc blocks: far longer than an x402 authorization stays valid. */
const LOG_WINDOWS = 10;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function createArcClient(rpcUrl: string = process.env.ARC_RPC_URL || ARC_TESTNET.defaultRpcUrl): PublicClient {
  return createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) }) as PublicClient;
}

/** Read-only view of Arc Testnet. Holds no keys and cannot sign. */
export class ArcChainReader implements ChainReader {
  constructor(private readonly client: PublicClient = createArcClient()) {}

  async getTx(txHash: TxHash): Promise<TxInfo | null> {
    if (!TX_HASH.test(txHash)) return null;
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash });
    } catch (err) {
      if (err instanceof TransactionReceiptNotFoundError) return null;
      throw err;
    }
    // Uncached: viem otherwise reuses a block number up to a few seconds old, which on a
    // sub-second chain can be behind the receipt's own block.
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    const transfers: TokenTransfer[] = [];
    for (const log of receipt.logs) {
      // ERC-20 Transfer has exactly two indexed args; ERC-721 has three and is skipped.
      if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length !== 3) continue;
      transfers.push({
        token: log.address.toLowerCase() as Address,
        from: topicToAddress(log.topics[1]!),
        to: topicToAddress(log.topics[2]!),
        value: log.data === '0x' ? 0n : BigInt(log.data),
      });
    }
    return {
      txHash,
      status: receipt.status === 'success' ? 'success' : 'reverted',
      // A receipt means the transaction is in a block, so it has at least one confirmation
      // even if the node answering getBlockNumber lags the one that served the receipt.
      confirmations: Math.max(1, Number(head - receipt.blockNumber) + 1),
      transfers,
    };
  }

  async authorizationUsed(authorizer: Address, nonce: `0x${string}`): Promise<{ used: boolean; txHash?: TxHash }> {
    const used = await this.client.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'authorizationState',
      args: [authorizer, nonce],
    });
    if (!used) return { used: false };
    // The state says it is used; the event says by which transaction. A node that has
    // pruned the logs still gives a definite "used".
    let toBlock = await this.client.getBlockNumber({ cacheTime: 0 });
    for (let window = 0; window < LOG_WINDOWS && toBlock >= 0n; window++) {
      const fromBlock = toBlock >= LOG_WINDOW_BLOCKS ? toBlock - LOG_WINDOW_BLOCKS + 1n : 0n;
      const logs = await this.client
        .getContractEvents({ address: USDC_ADDRESS, abi: erc20Abi, eventName: 'AuthorizationUsed', args: { authorizer, nonce }, fromBlock, toBlock })
        .catch(() => []);
      const txHash = logs[0]?.transactionHash;
      if (txHash) return { used: true, txHash: txHash as TxHash };
      if (fromBlock === 0n) break;
      toBlock = fromBlock - 1n;
    }
    return { used: true };
  }

  async getUsdcBalance(address: Address): Promise<Usdc> {
    return this.client.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    });
  }
}

const topicToAddress = (topic: string): Address => `0x${topic.slice(26).toLowerCase()}`;
