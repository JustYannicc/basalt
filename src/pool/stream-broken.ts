import { shape } from "./runtime-fleet/endpoint-trace.ts";

// A stream passes through several stacked wrappers that each see the same rejection, and a
// deliberate close of an inner lease reaches the outer ones as an error too.
const settled = new WeakSet<object>();
let second = 0;
let written = 0;

/** The error a wrapper ends its stream with when the pool closes it on purpose. */
export function connectionEnded(): Error {
  const error = new Error("Connection ended");
  settled.add(error);
  return error;
}

/**
 * Where a model stream broke, as closed classes and the platform's flags, never its text: one line
 * per failure however many wrappers see it. A replacement breaks every stream in the same instant,
 * so three lines a second say enough.
 */
export function reportStreamBroken(where: "terminal" | "native", error: unknown) {
  const object = typeof error === "object" && error !== null;
  if (object && settled.has(error)) return;
  if (object) settled.add(error);
  const at = Date.now();
  const current = Math.floor(at / 1_000);
  if (current !== second) {
    second = current;
    written = 0;
  }
  if (++written > 3) return;
  console.error("POOL_STREAM_BROKEN", { at, where, ...shape(error) });
}
