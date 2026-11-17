import { describe, expect, it } from 'vitest';
import { REQUEST_TIMEOUT_MS } from '../../src/redteam/merchant-client.js';
import { LIVE_SETTLE_MS } from '../../src/redteam/world.js';

describe('red-team timeouts', () => {
  // On Arc Testnet the merchant waits LIVE_SETTLE_MS for an unknown tx hash to appear
  // before rejecting it. If the client gave up first, the fake-tx-hash scenario would
  // end in a timeout error instead of a clean "blocked".
  it('lets the merchant finish waiting for a missing transaction before the client gives up', () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(LIVE_SETTLE_MS * 2);
  });
});
