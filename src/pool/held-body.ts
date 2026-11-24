/**
 * A copy of a model call's body, read from a tee beside the real send, so a hop can send the call
 * once more when the layer below it is lost before any answer. One module instance per isolate
 * keeps that isolate's budget: the pool entry's and the router's are apart.
 */

// Each reservation carries its own deadline: a request the platform cancels never runs its own
// release, and its bytes must not stay counted for the life of the isolate.
const reservations = new Map<object, { bytes: number; until: number }>();

/** Bytes held for replay in this isolate right now. */
export function heldBytes() {
  const now = Date.now();
  let total = 0;
  for (const [key, reservation] of reservations) {
    if (reservation.until <= now) reservations.delete(key);
    else total += reservation.bytes;
  }
  return total;
}

export type HoldRefusal = "body_too_large" | "body_unreadable" | "hold_budget_full" | "too_late";
export type Held = { body: Uint8Array<ArrayBuffer> } | { refused: HoldRefusal };
export interface HeldBody {
  ready: Promise<void>;
  take(): Held;
  release(): void;
}

/**
 * Holds the body only while a replay is still possible: up to the per-call and per-isolate
 * bounds, and until the hop releases it or the window closes, whichever is first.
 */
export function holdBody(
  body: ReadableStream<Uint8Array> | null,
  bounds: { maxBytes: number; budgetBytes: number; windowMs: number },
  skipped: () => void,
): HeldBody {
  if (!body)
    return {
      ready: Promise.resolve(),
      take: () => ({ body: new Uint8Array() }),
      release() {},
    };
  const reader = body.getReader();
  const key = {};
  const until = Date.now() + bounds.windowMs;
  let chunks: Uint8Array[] | undefined = [];
  let joined: Uint8Array<ArrayBuffer> | undefined;
  let refused: HoldRefusal | undefined;
  let reserved = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const free = (reason: HoldRefusal | "released") => {
    if (!refused && reason !== "released") refused = reason;
    if (reason === "released" && !refused) refused = "too_late";
    chunks = undefined;
    joined = undefined;
    reservations.delete(key);
    reserved = 0;
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  };
  timer = setTimeout(() => free("too_late"), bounds.windowMs);
  const ready = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !chunks) break;
        if (reserved + value.byteLength > bounds.maxBytes) return free("body_too_large");
        if (heldBytes() + value.byteLength > bounds.budgetBytes) {
          skipped();
          return free("hold_budget_full");
        }
        reserved += value.byteLength;
        reservations.set(key, { bytes: reserved, until });
        chunks.push(value);
      }
    } catch {
      return free("body_unreadable");
    }
    if (!chunks) return;
    const whole = new Uint8Array(reserved);
    let offset = 0;
    for (const chunk of chunks) {
      whole.set(chunk, offset);
      offset += chunk.byteLength;
    }
    chunks = undefined;
    joined = whole;
  })();
  return {
    ready,
    take: () => (joined ? { body: joined } : { refused: refused ?? "body_unreadable" }),
    release: () => free("released"),
  };
}
