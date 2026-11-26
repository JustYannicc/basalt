// The load driver's one door to the emulated upstream's shapes: their request bodies and their pass
// rule, so a call the driver passes is a call the stage's own check would pass.
import { paths, requestBody, verdict } from "../emulated-upstream/shapes.mjs";

export { paths };

/**
 * The pass rule for a `stream: false` answer. It belongs in shapes.mjs beside the streamed rule,
 * and is not there yet. Bind it here once it lands, `(shape, long, text) => { pass, reason }`, and a
 * non-streamed kind turns on with load data alone; until then the load shape refuses one.
 */
export const nonStreamedVerdict = undefined;

/** One kind's body: the shapes' own, under the kind's model, and unstreamed when the kind is. */
export function callBody(kind) {
  const body = requestBody(kind.shape, kind.prompt === "long");
  body.model = kind.model;
  if (!kind.stream) {
    body.stream = false;
    delete body.stream_options;
  }
  return body;
}

export function callVerdict(kind, text) {
  const long = kind.prompt === "long";
  if (kind.stream) return verdict(kind.shape, long, text);
  if (!nonStreamedVerdict) return { pass: false, reason: "no non-streamed verdict" };
  return nonStreamedVerdict(kind.shape, long, text);
}
