import { shape } from "./runtime-fleet/endpoint-trace.ts";

let second = 0;
let written = 0;

/**
 * Where a controller stream broke, as closed classes and the platform's flags, never its text.
 * A replacement breaks every stream in the same instant, so three lines a second say enough.
 */
export function reportStreamBroken(where: "terminal" | "native", error: unknown) {
  const at = Date.now();
  const current = Math.floor(at / 1_000);
  if (current !== second) {
    second = current;
    written = 0;
  }
  if (++written > 3) return;
  console.error("POOL_STREAM_BROKEN", { at, where, ...shape(error) });
}
