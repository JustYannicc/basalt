import { boundedLog } from "../bounded-log.ts";
import { heldBytes, holdBody, type Held, type HeldBody } from "../held-body.ts";

/**
 * A call a hold made wait is past the entry's replay window, and a device's assertion has run out,
 * by the time a runtime refuses it before its container send. The controller already admitted it,
 * so it is the only hop that can still send it again. It keeps a copy of such a call's body past
 * the send inside these bounds, smaller than an entry's because one controller serves every call;
 * without a copy the call keeps the unsent refusal it had before.
 */
export const heldCopyBytes = 4 * 1024 * 1024;
export const heldCopyBudgetBytes = 16 * 1024 * 1024;
/** The entry's own pace for an unsent refusal (`controllerReplayDelayMs`). */
export const heldResendMs = 1_000;

export function keepHeldCopy(body: ReadableStream<Uint8Array> | null, windowMs: number) {
  return holdBody(
    body,
    { maxBytes: heldCopyBytes, budgetBytes: heldCopyBudgetBytes, windowMs },
    () => boundedLog("POOL_HELD_COPY_SKIPPED", { heldBytes: heldBytes() }, console.error),
  );
}

/** The copy's bytes once read in full, or why there are none. */
export async function heldCopyBody(copy: HeldBody): Promise<Held> {
  await copy.ready;
  return copy.take();
}
