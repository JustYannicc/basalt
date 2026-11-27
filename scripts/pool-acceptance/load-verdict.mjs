// The load driver's one door to the emulated upstream's shapes: their request bodies and their pass
// rule, so a call the driver passes is a call the stage's own check would pass.
import { paths, requestBody, verdict } from "../emulated-upstream/shapes.mjs";

export { paths };

/**
 * Whether the shapes build and judge a `stream: false` call, through the `{ stream }` option their
 * owner is adding beside the streamed rule. Until `requestBody` honours it, the load shape refuses
 * an unstreamed kind; once it does, one turns on with load data alone.
 */
export const judgesUnstreamed = requestBody("chat", false, { stream: false }).stream === false;

/** One kind's body: the shapes' own, under the kind's model, with the send's marker when given. */
export function callBody(kind, marker) {
  const body = requestBody(kind.shape, kind.prompt === "long", { stream: kind.stream, marker });
  body.model = kind.model;
  return body;
}

export function callVerdict(kind, text) {
  return verdict(kind.shape, kind.prompt === "long", text, { stream: kind.stream });
}
