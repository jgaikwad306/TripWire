import type { FacilitatorEvmSigner } from '@x402/evm';
import { encodeFunctionData, getAddress, verifyTypedData, type Abi, type PublicClient } from 'viem';
import type { Address, TxHash } from '../types.js';

/** What submitting a contract call takes: our wallet sends it and pays the gas. */
export type ContractCaller = (contract: Address, callData: `0x${string}`) => Promise<TxHash>;

/**
 * Lets the official x402 facilitator run against Arc: reads and receipts go through a
 * public RPC node, and the one write (transferWithAuthorization) is sent from our own
 * wallet, which pays the gas.
 */
export function arcFacilitatorSigner(client: PublicClient, submitter: Address, call: ContractCaller): FacilitatorEvmSigner {
  return {
    getAddresses: () => [getAddress(submitter)],
    readContract: (args) =>
      client.readContract({
        address: args.address,
        abi: args.abi as Abi,
        functionName: args.functionName,
        args: args.args ?? [],
        ...(args.account ? { account: args.account } : {}),
      }),
    verifyTypedData: (args) => verifyTypedData(args as Parameters<typeof verifyTypedData>[0]),
    writeContract: (args) =>
      call(
        args.address.toLowerCase() as Address,
        encodeFunctionData({ abi: args.abi as Abi, functionName: args.functionName, args: args.args }),
      ),
    sendTransaction: (args) => call(args.to.toLowerCase() as Address, args.data),
    waitForTransactionReceipt: (args) => client.waitForTransactionReceipt({ hash: args.hash, timeout: args.timeout ?? 60_000 }),
    getCode: (args) => client.getCode({ address: args.address }),
  };
}
