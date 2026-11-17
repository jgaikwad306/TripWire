/**
 * Shared contracts between the four lanes. This is the ONLY file everyone depends on.
 * Change it only after telling the group — every lane compiles against it.
 *
 * All USDC amounts are bigint in 6-decimal base units (1 USDC = 1_000_000n).
 * Use parseUsdc / formatUsdc from ./constants.ts at the edges.
 */

export type Address = `0x${string}`;
export type TxHash = `0x${string}`;
export type Usdc = bigint;

export type WalletRole = 'vault' | 'hot' | 'merchant' | 'attacker';

// ───────────────────────── Lane A: chain & wallets ─────────────────────────

/** Moves money. Only the guard (and the red-team harness) may hold one of these. */
export interface WalletProvider {
  addressOf(role: WalletRole): Address;
  getBalance(role: WalletRole): Promise<Usdc>;
  /** Sends USDC and resolves once the transaction is confirmed. */
  transfer(args: { from: WalletRole; to: Address; amount: Usdc }): Promise<{ txHash: TxHash }>;
}

/** One ERC-20 Transfer log. `token` is the emitting contract — compare it to USDC_ADDRESS. */
export interface TokenTransfer {
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
}

export interface TxInfo {
  txHash: TxHash;
  status: 'success' | 'reverted';
  confirmations: number;
  transfers: TokenTransfer[];
}

/** Read-only view of Arc. Never signs anything. */
export interface ChainReader {
  /** null when the transaction does not exist. */
  getTx(txHash: TxHash): Promise<TxInfo | null>;
  getUsdcBalance(address: Address): Promise<Usdc>;
}

// ───────────────────────────── Lane B: guard ─────────────────────────────

/** What a merchant says something costs and where to pay. Untrusted input. */
export interface Quote {
  merchantUrl: string;
  item: string;
  payTo: Address;
  amount: Usdc;
  description?: string;
}

/**
 * How the guard asks a merchant for a price. Injected so tests can skip HTTP.
 * Real one (lane C exports it): GET {merchantUrl}/quote?item=… →
 *   { payTo: "0x…", amount: "<base units as string>", description?: string }
 */
export type QuoteFetcher = (merchantUrl: string, item: string) => Promise<Quote>;

/** A quote the guard itself fetched and recorded. Payments must match one of these. */
export interface PaymentIntent extends Quote {
  id: string;
  createdAt: number;
  status: 'open' | 'paid';
}

/** What the LLM asks for. Every field is untrusted. */
export interface PaymentRequest {
  intentId: string;
  payTo: Address;
  amount: Usdc;
  reason: string;
}

export interface ReceiptRequest {
  orderId: string;
  txHash: TxHash;
  expectedTo: Address;
  expectedAmount: Usdc;
}

export interface Decision {
  allowed: boolean;
  /** Which check decided, e.g. 'intent-match', 'allowlist', 'price', 'limits', 'loop', 'replay', 'ok'. */
  check: string;
  reason: string;
  /** Set when a payment was actually sent. */
  txHash?: TxHash;
}

export interface Guard {
  /** Fetches a quote from the merchant and records it as an intent. */
  getQuote(merchantUrl: string, item: string): Promise<PaymentIntent>;
  /** Send side: runs the checks and, if they pass, pays from the hot wallet. */
  requestPayment(req: PaymentRequest): Promise<Decision>;
  /** Receive side: verifies an incoming payment onchain before goods are delivered. */
  verifyReceipt(req: ReceiptRequest): Promise<Decision>;
  /** Hold side: sweeps hot balance above the cap into the vault. */
  rebalance(): Promise<void>;
  hotBalance(): Promise<Usdc>;
  /** Every decision made so far, oldest first. The report reads this. */
  decisions(): Decision[];
}

// ───────────────────────── Lane C: agent & merchant ─────────────────────────

/** The only things the LLM can do. Each is routed through the guard (or straight to the wallet in --no-guard). */
export interface AgentTools {
  getQuote(merchantUrl: string, item: string): Promise<PaymentIntent>;
  requestPayment(req: PaymentRequest): Promise<Decision>;
  checkBalance(): Promise<Usdc>;
}

export interface ToolCall {
  name: string;
  args: unknown;
  result: unknown;
}

export interface AgentResult {
  finalMessage: string;
  toolCalls: ToolCall[];
}

export interface Agent {
  name: string;
  run(task: string, tools: AgentTools): Promise<AgentResult>;
}

/** Attack switches on the mock merchant. One per send-side scenario. */
export type MerchantMode =
  | 'honest'
  | 'swap-payto'
  | 'inflate-price'
  | 'inject-prompt'
  | 'retry-loop'
  | 'fake-owner'
  | 'move-to-safety';

export interface MerchantHandle {
  url: string;
  setMode(mode: MerchantMode): void;
  close(): Promise<void>;
}

// ──────────────────────── Lane D: red team & report ────────────────────────

export type ScenarioCategory = 'send' | 'hold' | 'receive' | 'honest';

export interface ScenarioContext {
  wallet: WalletProvider;
  chain: ChainReader;
  guard: Guard;
  agent: Agent;
  tools: AgentTools;
  merchant: MerchantHandle;
  attacker: Address;
}

export interface ScenarioOutcome {
  /** Did the purchase / delivery go through? */
  completed: boolean;
  txHashes: TxHash[];
  notes?: string;
}

export interface Scenario {
  id: string;
  title: string;
  category: ScenarioCategory;
  /** Attacks should be 'blocked'; honest purchases should be 'completed'. */
  expected: 'blocked' | 'completed';
  run(ctx: ScenarioContext): Promise<ScenarioOutcome>;
}

export interface ScenarioResult {
  id: string;
  title: string;
  category: ScenarioCategory;
  expected: 'blocked' | 'completed';
  passed: boolean;
  /** Attacker balance gained during the scenario. */
  usdcLost: Usdc;
  txHashes: TxHash[];
  decisions: Decision[];
  notes?: string;
  error?: string;
}

export interface Report {
  agentName: string;
  guarded: boolean;
  startedAt: string;
  /** 0–100. */
  overall: number;
  byCategory: Record<ScenarioCategory, { passed: number; total: number; score: number }>;
  usdcLost: Usdc;
  honestCompleted: number;
  honestTotal: number;
  results: ScenarioResult[];
}
