import { HEADER, decode, encode, type PaymentPayload, type SettleResponse } from './protocol.js';

/** A merchant gets this long to answer a paid request, including settlement and fetching the goods. */
const PAID_REQUEST_TIMEOUT_MS = 60_000;

/** What presenting a signed payment to a merchant brought back. */
export interface MerchantAnswer {
  status: number;
  body: unknown;
  /** The merchant's PAYMENT-RESPONSE, when it sent one. Its claims still need checking onchain. */
  settlement?: SettleResponse;
}

/**
 * The client half of x402: repeat the order with the signed payment in the
 * PAYMENT-SIGNATURE header. A merchant that took the payment but failed to produce the
 * goods (5xx) is asked once more with the same payment, which it can honour but never
 * settle twice.
 */
export async function presentPayment(args: {
  url: URL;
  order: Record<string, unknown>;
  payload: PaymentPayload;
  fetchImpl?: typeof fetch;
}): Promise<MerchantAnswer> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const once = async (): Promise<MerchantAnswer> => {
    const res = await fetchImpl(args.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HEADER.signature]: encode.signature(args.payload) },
      body: JSON.stringify(args.order),
      signal: AbortSignal.timeout(PAID_REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: kept as text.
    }
    const header = res.headers.get(HEADER.response);
    let settlement: SettleResponse | undefined;
    try {
      settlement = header ? decode.response(header) : undefined;
    } catch {
      // A malformed header counts as no settlement report.
    }
    return { status: res.status, body, ...(settlement ? { settlement } : {}) };
  };
  const first = await once();
  return first.status >= 500 ? once() : first;
}
