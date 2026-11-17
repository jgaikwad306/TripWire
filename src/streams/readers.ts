import { USDC_ADDRESS } from '../constants.js';
import type { ActivityReader, UsdcTransfer } from '../chain/activity.js';
import type { Address, ChainReader, TxHash, TxInfo } from '../types.js';
import { StreamClient } from './client.js';
import { receiptSchema, topicAddress, TRANSFER } from './model.js';

/** Indexed absence is never negative chain evidence. RPC remains the fallback. */
export class StreamChainReader implements ChainReader {
  constructor(private readonly fallback: ChainReader, private readonly client: StreamClient) {}
  async getTx(txHash: TxHash): Promise<TxInfo | null> {
    try {
      const receipt = receiptSchema.nullable().parse(await this.client.request(`/receipt/${txHash.toLowerCase()}`));
      if (receipt) {
        const status = await this.client.status();
        return {
          txHash: receipt.transactionHash, status: receipt.status,
          confirmations: Math.max(1, status.coveredThrough - receipt.blockNumber + 1),
          transfers: receipt.logs.filter(l => l.topics[0] === TRANSFER && l.topics.length === 3 && /^0x[0-9a-f]{64}$/i.test(l.data)).map(l => ({
            token: l.address, from: topicAddress(l.topics[1]!), to: topicAddress(l.topics[2]!), value: BigInt(l.data),
          })),
        };
      }
    } catch { /* A disconnected index does not prevent RPC receipt verification. */ }
    return this.fallback.getTx(txHash);
  }
  getUsdcBalance(address: Address) { return this.fallback.getUsdcBalance(address); }
  async authorizationUsed(authorizer: Address, nonce: TxHash): Promise<{ used: boolean; txHash?: TxHash }> {
    try {
      const hash = await this.client.request<unknown>(`/authorization?from=${authorizer.toLowerCase()}&nonce=${nonce.toLowerCase()}`);
      if (typeof hash === 'string' && /^0x[0-9a-f]{64}$/.test(hash)) return { used: true, txHash: hash as TxHash };
    } catch { /* An index miss or failure must still consult authorizationState. */ }
    return this.fallback.authorizationUsed(authorizer, nonce);
  }
}

export class StreamActivityReader implements ActivityReader {
  constructor(private readonly fallback: ActivityReader, private readonly client: StreamClient) {}
  async getUsdcActivity(address: Address, limit: number): Promise<UsdcTransfer[]> {
    try {
      const raw = await this.client.request<unknown>(`/activity?address=${address.toLowerCase()}`);
      const receipts = receiptSchema.array().nullable().parse(raw);
      if (receipts) return receipts.flatMap(r => r.logs.filter(l => l.address === USDC_ADDRESS.toLowerCase() && l.topics[0] === TRANSFER && l.topics.length === 3 && /^0x[0-9a-f]{64}$/i.test(l.data)).map(l => ({
        txHash: r.transactionHash, from: topicAddress(l.topics[1]!), to: topicAddress(l.topics[2]!), amount: BigInt(l.data), blockNumber: r.blockNumber, logIndex: l.logIndex,
      }))).filter(t => t.from === address.toLowerCase() || t.to === address.toLowerCase()).sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex).slice(0, limit).map(({ logIndex: _index, ...transfer }) => transfer);
    } catch { /* Explorer supports unmonitored addresses and disconnected indexes. */ }
    return this.fallback.getUsdcActivity(address, limit);
  }
}
