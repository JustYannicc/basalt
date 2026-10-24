import type { ProductEvent } from "../telemetry/product.ts";

export type ProductEventCallback = (event: ProductEvent, accountId: string) => void;

/** Keep optional analytics transport outside the domain operation's result. */
export function emitProductEvent(
  callback: ProductEventCallback | undefined,
  event: ProductEvent,
  accountId: string,
): void {
  try { callback?.(event, accountId); }
  catch { /* Analytics must not change the domain result. */ }
}
