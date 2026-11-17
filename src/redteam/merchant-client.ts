/** Must stay well above LIVE_SETTLE_MS: the merchant waits that long for an unknown tx hash before rejecting it. */
export const REQUEST_TIMEOUT_MS = 30_000;

export interface BuyResponse {
  status: number;
  body: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * POST {merchantUrl}/buy. Without a txHash the merchant answers 402 with payment
 * details; with one it either delivers (200) or rejects the proof (402).
 */
export async function postBuy(merchantUrl: string, body: { item: string; txHash?: string }): Promise<BuyResponse> {
  const res = await fetch(new URL('/buy', merchantUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // A non-JSON body is treated as empty: the status code alone decides what callers do.
  const parsed: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body: isRecord(parsed) ? parsed : {} };
}

export const wasDelivered = (res: BuyResponse): boolean => res.status === 200 && res.body.delivered === true;
