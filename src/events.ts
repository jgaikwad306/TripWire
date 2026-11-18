import type { Decision, PaidRequest, PaymentIntent, PaymentRequest, ScenarioResult, ToolCall, TranscriptEntry, TxHash, Usdc, WalletRole } from './types.js';

/** Public payment fields only: never expose a reusable PAYMENT-SIGNATURE. */
export interface ReceiptObservation {
  orderId: string;
  expectedTo: string;
  expectedAmount: string;
  payment?: { from: string; to: string; value: string; nonce: string; asset: string };
}

/** Observations of execution, never instructions to the agent or guard. */
export type ExecutionEvent =
  | { type: 'model.waiting'; data: { step: number } }
  | { type: 'tool.started'; data: { callId: string; name: string; args: unknown } }
  | { type: 'tool.completed'; data: { callId: string; call: ToolCall } }
  | { type: 'tool.failed'; data: { callId: string; name: string; error: string } }
  | { type: 'transcript'; data: { entry: TranscriptEntry } }
  | { type: 'quote.recorded'; data: { intent: PaymentIntent } }
  | { type: 'operation.started'; data: { operationId: string; side: 'send' | 'receive' | 'api'; request: PaymentRequest | ReceiptObservation | PaidRequest } }
  | { type: 'guard.decision'; data: { operationId: string; side: 'send' | 'receive' | 'api'; request: PaymentRequest | ReceiptObservation | PaidRequest; decision: Decision; paid?: { amount: string; payTo: string; network: string; resource: string }; status?: number } }
  | { type: 'gateway.balances'; data: { hot: Usdc; merchant: Usdc; attacker: Usdc; when: 'start' | 'end' } }
  | { type: 'transfer.started' | 'transfer.confirmed' | 'transfer.failed'; data: { operationId: string; from: WalletRole; to: string; amount: Usdc; asset: 'USDC' | 'counterfeit'; txHash?: TxHash; error?: string } }
  | { type: 'settlement.started' | 'settlement.completed' | 'settlement.failed'; data: { operationId: string; from: string; to: string; amount: string; asset: 'USDC' | 'counterfeit'; txHash?: TxHash; error?: string } }
  | { type: 'signature.started' | 'signature.completed'; data: { role: WalletRole } }
  | { type: 'delivery'; data: { orderId: string; item: string; txHash?: TxHash } }
  | { type: 'world.ready'; data: { merchant: string; attacker: string; hot: Usdc; vault: Usdc; hotCap: Usdc } }
  | { type: 'scenario.stage'; data: { stage: 'preparing' | 'executing' | 'measuring' | 'balances' } }
  | { type: 'scenario.started'; data: { id: string } }
  | { type: 'scenario.completed'; data: { result: ScenarioResult } };

export type EventSink = (event: ExecutionEvent) => void;

/** Instrumentation and disconnected viewers must never change payment behavior. */
export function emit(sink: EventSink | undefined, event: ExecutionEvent): void {
  try { sink?.(event); } catch { /* Observers cannot interrupt a payment. */ }
}
