import type { FacilitatorEvmSigner } from '@x402/evm';
import {
  getAddress,
  keccak256,
  pad,
  recoverTypedDataAddress,
  serializeSignature,
  toHex,
  verifyTypedData,
  type Hex,
  type Log,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ActivityReader, UsdcTransfer } from '../chain/activity.js';
import { ARC_TESTNET, USDC_ADDRESS } from '../constants.js';
import { TransferRejectedError } from '../errors.js';
import type {
  Address,
  ChainReader,
  TokenTransfer,
  TxHash,
  TxInfo,
  TypedDataRequest,
  Usdc,
  WalletProvider,
  WalletRole,
} from '../types.js';

/** Fixed test keys, so offline wallets sign real EIP-712 signatures. Never fund these anywhere real. */
export const FAKE_KEYS: Record<WalletRole, Hex> = {
  vault: keccak256(toHex('tripwire-fake-wallet:vault')),
  hot: keccak256(toHex('tripwire-fake-wallet:hot')),
  merchant: keccak256(toHex('tripwire-fake-wallet:merchant')),
  attacker: keccak256(toHex('tripwire-fake-wallet:attacker')),
};

const addressOfKey = (key: Hex): Address => privateKeyToAccount(key).address.toLowerCase() as Address;

export const FAKE_ADDRESSES: Record<WalletRole, Address> = {
  vault: addressOfKey(FAKE_KEYS.vault),
  hot: addressOfKey(FAKE_KEYS.hot),
  merchant: addressOfKey(FAKE_KEYS.merchant),
  attacker: addressOfKey(FAKE_KEYS.attacker),
};

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Stand-in bytecode: the facilitator only checks that USDC is a contract. */
const CONTRACT_CODE: Hex = '0x6080604052';

/** The arguments of transferWithAuthorization, with the signature already joined. */
interface Authorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
  signature: Hex;
}

/** Address of the counterfeit token used in the "fake USDC" scenario. */
export const FAKE_TOKEN_ADDRESS: Address = '0x00000000000000000000000000000000000fa4e0';

/**
 * In-memory stand-in for Arc + Circle wallets. Implements both WalletProvider and
 * ChainReader over one ledger, so a transfer made through the wallet is visible to
 * the chain reader — just like the real thing. No network, no keys.
 *
 * Lane A replaces this with CircleWallet + ArcChainReader; everyone else tests against it.
 */
export class FakeLedger implements WalletProvider, ChainReader, ActivityReader {
  private balances = new Map<Address, Usdc>();
  private txs = new Map<TxHash, TxInfo>();
  private nonce = 0;
  private byKey = new Map<string, TxHash>();
  /** EIP-3009 authorizations already used, by `authorizer:nonce`, with the transaction that used them. */
  private usedAuthorizations = new Map<string, TxHash>();
  private readonly now: () => number;

  constructor(initial: Partial<Record<WalletRole, Usdc>> = {}, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    for (const [role, amount] of Object.entries(initial) as [WalletRole, Usdc][]) {
      this.balances.set(FAKE_ADDRESSES[role], amount);
    }
  }

  addressOf(role: WalletRole): Address {
    return FAKE_ADDRESSES[role];
  }

  async getBalance(role: WalletRole): Promise<Usdc> {
    return this.getUsdcBalance(FAKE_ADDRESSES[role]);
  }

  async transfer(args: { from: WalletRole; to: Address; amount: Usdc; idempotencyKey?: string }): Promise<{ txHash: TxHash }> {
    // As with Circle: a request repeated under the same key returns the first transaction.
    const earlier = args.idempotencyKey ? this.byKey.get(args.idempotencyKey) : undefined;
    if (earlier) return { txHash: earlier };
    const txHash = this.transferFrom(FAKE_ADDRESSES[args.from], args.to, args.amount);
    if (args.idempotencyKey) this.byKey.set(args.idempotencyKey, txHash);
    return { txHash };
  }

  async signTypedData(role: WalletRole, data: TypedDataRequest): Promise<Hex> {
    // viem's types want a literal schema; the shape is checked when the signature is verified.
    return privateKeyToAccount(FAKE_KEYS[role]).signTypedData(data as Parameters<ReturnType<typeof privateKeyToAccount>['signTypedData']>[0]);
  }

  async authorizationUsed(authorizer: Address, nonce: Hex): Promise<{ used: boolean; txHash?: TxHash }> {
    const txHash = this.usedAuthorizations.get(authorizationKey(authorizer, nonce));
    return txHash ? { used: true, txHash } : { used: false };
  }

  /**
   * The ledger seen through a facilitator's eyes: USDC as an EIP-3009 token. It checks the
   * payer's signature, the validity window, the nonce and the balance exactly as the real
   * contract does, so the official x402 facilitator code runs against it unchanged.
   */
  facilitatorSigner(): FacilitatorEvmSigner {
    const usdc = (address: string): boolean => address.toLowerCase() === USDC_ADDRESS.toLowerCase();
    const notAContract = (address: string): never => {
      throw new Error(`execution reverted: ${address} is not a contract`);
    };
    return {
      getAddresses: () => [getAddress(FAKE_ADDRESSES.merchant)],
      readContract: async ({ address, functionName, args = [] }) => {
        if (!usdc(address)) return notAContract(address);
        switch (functionName) {
          case 'name':
            return 'USDC';
          case 'version':
            return '2';
          case 'balanceOf':
            return this.getUsdcBalance(args[0] as Address);
          case 'authorizationState':
            return (await this.authorizationUsed(args[0] as Address, args[1] as Hex)).used;
          case 'transferWithAuthorization':
            // A simulation: every check runs and nothing moves.
            await this.checkAuthorization(authorizationFromArgs(args));
            return undefined;
          default:
            throw new Error(`execution reverted: USDC has no function ${functionName} here`);
        }
      },
      verifyTypedData: (args) => verifyTypedData(args as Parameters<typeof verifyTypedData>[0]),
      writeContract: async ({ address, functionName, args }) => {
        if (!usdc(address) || functionName !== 'transferWithAuthorization') {
          throw new Error(`execution reverted: unsupported call ${functionName} on ${address}`);
        }
        return this.transferWithAuthorization(authorizationFromArgs(args));
      },
      sendTransaction: async () => {
        throw new Error('The fake ledger does not take raw transactions.');
      },
      waitForTransactionReceipt: async ({ hash }) => {
        const tx = this.txs.get(hash as TxHash);
        if (!tx) throw new Error(`Transaction ${hash} not found`);
        return { status: tx.status, logs: tx.transfers.map((t, i) => transferLog(hash as TxHash, t, i)) };
      },
      getCode: async ({ address }) => (usdc(address) ? CONTRACT_CODE : undefined),
    };
  }

  /** What the USDC contract checks before honouring an authorization. Throws with the contract's own wording. */
  private async checkAuthorization(auth: Authorization): Promise<void> {
    const now = BigInt(this.now());
    if (now <= auth.validAfter) throw new Error('execution reverted: FiatTokenV2: authorization is not yet valid');
    if (now >= auth.validBefore) throw new Error('execution reverted: FiatTokenV2: authorization is expired');
    if ((await this.authorizationUsed(auth.from, auth.nonce)).used) {
      throw new Error('execution reverted: FiatTokenV2: authorization is used or canceled');
    }
    const signer = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: ARC_TESTNET.chainId, verifyingContract: getAddress(USDC_ADDRESS) },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: { from: auth.from, to: auth.to, value: auth.value, validAfter: auth.validAfter, validBefore: auth.validBefore, nonce: auth.nonce },
      signature: auth.signature,
    }).catch(() => undefined);
    if (!signer || norm(signer) !== norm(auth.from)) throw new Error('execution reverted: FiatTokenV2: invalid signature');
    const balance = await this.getUsdcBalance(auth.from);
    if (balance < auth.value) throw new Error('execution reverted: ERC20: transfer amount exceeds balance');
  }

  private async transferWithAuthorization(auth: Authorization): Promise<TxHash> {
    await this.checkAuthorization(auth);
    const txHash = this.transferFrom(auth.from, auth.to, auth.value);
    this.usedAuthorizations.set(authorizationKey(auth.from, auth.nonce), txHash);
    return txHash;
  }

  async getTx(txHash: TxHash): Promise<TxInfo | null> {
    return this.txs.get(txHash) ?? null;
  }

  async getUsdcBalance(address: Address): Promise<Usdc> {
    return this.balances.get(norm(address)) ?? 0n;
  }

  /** USDC transfers the address sent or received, newest first. A transaction's position stands in for its block. */
  async getUsdcActivity(address: Address, limit: number): Promise<UsdcTransfer[]> {
    const wanted = norm(address);
    const found = [...this.txs.values()].flatMap((tx, index) =>
      tx.transfers
        .filter((t) => norm(t.token) === norm(USDC_ADDRESS) && (norm(t.from) === wanted || norm(t.to) === wanted))
        .map((t): UsdcTransfer => ({ txHash: tx.txHash, from: norm(t.from), to: norm(t.to), amount: t.value, blockNumber: index + 1 })),
    );
    return found.reverse().slice(0, limit);
  }

  // ── test helpers (not part of either interface) ──

  /** Real-USDC transfer from any address, e.g. a customer paying the merchant. */
  transferFrom(from: Address, to: Address, amount: Usdc): TxHash {
    if (amount <= 0n) throw new TransferRejectedError('Amount must be positive');
    const fromBal = this.balances.get(norm(from)) ?? 0n;
    if (fromBal < amount) throw new TransferRejectedError(`Insufficient balance: has ${fromBal}, needs ${amount}`);
    this.balances.set(norm(from), fromBal - amount);
    this.balances.set(norm(to), (this.balances.get(norm(to)) ?? 0n) + amount);
    return this.record([{ token: USDC_ADDRESS, from, to, value: amount }]);
  }

  /** Give an address USDC out of thin air (the faucet). */
  fund(address: Address, amount: Usdc): void {
    this.balances.set(norm(address), (this.balances.get(norm(address)) ?? 0n) + amount);
  }

  /** A confirmed tx that moves a counterfeit token — USDC balances do not change. */
  counterfeitTransfer(from: Address, to: Address, amount: bigint, token: Address = FAKE_TOKEN_ADDRESS): TxHash {
    return this.record([{ token, from, to, value: amount }]);
  }

  /** A well-formed hash that does not exist onchain. */
  nonexistentTxHash(): TxHash {
    return `0x${'dead'.repeat(16)}`;
  }

  private record(transfers: TokenTransfer[]): TxHash {
    const txHash = `0x${(++this.nonce).toString(16).padStart(64, '0')}` as TxHash;
    this.txs.set(txHash, { txHash, status: 'success', confirmations: 1, transfers });
    return txHash;
  }
}

const norm = (a: Address): Address => a.toLowerCase() as Address;

const authorizationKey = (authorizer: Address, nonce: Hex): string => `${norm(authorizer)}:${nonce.toLowerCase()}`;

/** transferWithAuthorization takes the signature either as (v, r, s) or as bytes. */
function authorizationFromArgs(args: readonly unknown[] = []): Authorization {
  const [from, to, value, validAfter, validBefore, nonce, ...sig] = args;
  const signature =
    sig.length === 3
      ? serializeSignature({ v: BigInt(sig[0] as number), r: sig[1] as Hex, s: sig[2] as Hex })
      : (sig[0] as Hex);
  return {
    from: norm(from as Address),
    to: norm(to as Address),
    value: BigInt(value as bigint),
    validAfter: BigInt(validAfter as bigint),
    validBefore: BigInt(validBefore as bigint),
    nonce: nonce as Hex,
    signature,
  };
}

/** An ERC-20 Transfer log in the shape viem decodes. */
function transferLog(txHash: TxHash, t: TokenTransfer, logIndex: number): Log {
  return {
    address: t.token,
    topics: [TRANSFER_TOPIC, pad(t.from), pad(t.to)],
    data: pad(toHex(t.value)),
    blockHash: null,
    blockNumber: null,
    logIndex,
    transactionHash: txHash,
    transactionIndex: null,
    removed: false,
  } as unknown as Log;
}
