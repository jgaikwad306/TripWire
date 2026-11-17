// Executed by QuickNode, not by Node. setup injects the Circle wallet addresses.
function main(stream) {
  const watched = /*WATCHED_ADDRESSES*/ [];
  const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const legacy = '0x62f084c00a442dcf51cdbb51beed2839bf42a268da8474b0e98f38edb7db5a22';
  const emitters = ['0x3600000000000000000000000000000000000000', '0xfffffffffffffffffffffffffffffffffffffffe', '0x1800000000000000000000000000000000000000'];
  const address = topic => ('0x' + topic.slice(-40)).toLowerCase();
  const number = value => typeof value === 'number' ? value : parseInt(value, 16);
  return {
    version: 1,
    network: stream.metadata.network,
    streamId: stream.metadata.stream_id,
    blocks: stream.data.map(entry => ({
      number: number(entry.block.number), hash: entry.block.hash,
      parentHash: entry.block.parentHash, timestamp: number(entry.block.timestamp),
      receipts: (entry.receipts || []).filter(receipt => (receipt.logs || []).some(log => {
        if (!emitters.includes(log.address.toLowerCase()) || log.topics.length !== 3) return false;
        if (![transfer, legacy].includes(log.topics[0].toLowerCase())) return false;
        return watched.includes(address(log.topics[1])) || watched.includes(address(log.topics[2]));
      })).map(receipt => ({
        transactionHash: receipt.transactionHash, blockHash: receipt.blockHash,
        blockNumber: number(receipt.blockNumber), status: number(receipt.status) === 1 ? 'success' : 'reverted',
        logs: receipt.logs.map(log => ({ address: log.address, topics: log.topics, data: log.data, logIndex: number(log.logIndex) })),
      })),
    })),
  };
}
