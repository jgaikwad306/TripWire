import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { createWalletClient, http, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcTestnet, createArcClient } from '../chain/arc.js';
import { ARC_TESTNET } from '../constants.js';
import type { Address, TxHash } from '../types.js';

/**
 * The attacker's side of the "counterfeit USDC" scenario. The attacker is a throwaway
 * local key (ATTACKER_PRIVATE_KEY) — deliberately NOT a guarded Circle wallet. It needs
 * a little faucet USDC for gas.
 */

const SOURCE_PATH = fileURLToPath(new URL('../../contracts/FakeUSDC.sol', import.meta.url));

export function compileFakeUsdc(): { abi: Abi; bytecode: Hex } {
  const input = {
    language: 'Solidity',
    sources: { 'FakeUSDC.sol': { content: readFileSync(SOURCE_PATH, 'utf8') } },
    settings: {
      // 'paris' avoids PUSH0, so the bytecode runs on any EVM version.
      evmVersion: 'paris',
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'));
  const contract = out.contracts['FakeUSDC.sol'].FakeUSDC;
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

function attackerClients(privateKey: Hex, rpcUrl = process.env.ARC_RPC_URL || ARC_TESTNET.defaultRpcUrl) {
  const account = privateKeyToAccount(privateKey);
  return {
    account,
    wallet: createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl) }),
    reader: createArcClient(rpcUrl),
  };
}

/** Deploys FakeUSDC with the whole supply minted to the attacker. Returns its address. */
export async function deployFakeUsdc(privateKey: Hex, supply = 1_000_000_000_000n): Promise<Address> {
  const { wallet, reader } = attackerClients(privateKey);
  const { abi, bytecode } = compileFakeUsdc();
  const hash = await wallet.deployContract({ abi, bytecode, args: [supply] });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error(`FakeUSDC deployment failed (${hash})`);
  return receipt.contractAddress.toLowerCase() as Address;
}

/** Sends counterfeit tokens. The tx is real and confirmed; only the token is fake. */
export async function sendCounterfeit(args: {
  privateKey: Hex;
  token: Address;
  to: Address;
  amount: bigint;
}): Promise<TxHash> {
  const { wallet, reader } = attackerClients(args.privateKey);
  const { abi } = compileFakeUsdc();
  const hash = await wallet.writeContract({
    address: args.token,
    abi,
    functionName: 'transfer',
    args: [args.to, args.amount],
  });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Counterfeit transfer reverted (${hash})`);
  return hash;
}
