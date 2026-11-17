import type { Usdc } from '../types.js';

/** How much the hot wallet holds above its cap; 0 when at or under it. */
export const excessOverCap = (hotBalance: Usdc, cap: Usdc): Usdc => (hotBalance > cap ? hotBalance - cap : 0n);
