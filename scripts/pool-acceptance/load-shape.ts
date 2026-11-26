import { AcceptanceFailure, isObject, type JsonObject } from "./types.ts";
import { nonStreamedVerdict, type Shape, type VerdictKind } from "./load-verdict.mjs";

/** One kind of call in the mix: which protocol, which prompt, and the profile it is judged by. */
export interface LoadKind extends VerdictKind {
  readonly name: string;
  /** Its share of the mix, against the other kinds' weights. */
  readonly weight: number;
  /** The mock profile's own time to first byte; a call more than `delayBarMs` above it is delayed. */
  readonly ttfbProfileMs: number;
}

export interface LoadRamp {
  /** Workers sending from the start. */
  readonly from: number;
  /** Workers added at each step, until `concurrency`. */
  readonly step: number;
  readonly intervalMs: number;
}

export interface LoadShape {
  /** Workers at the end of the ramp; each sends calls back to back. */
  readonly concurrency: number;
  /** No call starts after this long; calls in flight then still finish. */
  readonly durationMs: number;
  /** At most this many calls in all, when set: a short smoke run. */
  readonly calls: number | undefined;
  readonly ramp: LoadRamp | undefined;
  /** Sends per call while the answer says retry, the first included. Each one is recorded. */
  readonly maxAttempts: number;
  readonly attemptTimeoutMs: number;
  readonly mix: readonly LoadKind[];
}

/** A call is delayed when its first byte comes this much later than its profile's. Not an input. */
export const delayBarMs = 30_000;

const shapes: readonly Shape[] = ["chat", "responses", "messages"];
// The models the test pool's two emulated accounts serve, one per protocol (docs/pools.md).
const defaultModels: Record<Shape, string> = {
  chat: "emulated-chat",
  responses: "emulated-codex",
  messages: "emulated-claude",
};
// The mock's fixture profiles (scripts/emulated-upstream/fixtures.mjs): its ttft for each prompt.
const profileMs = { short: 200, long: 300 };
// The pool's own rule for a model name (src/pool/provider-accounts/definitions.ts).
const modelName = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
const kindName = /^[a-z0-9][a-z0-9-]{0,39}$/u;

const kind = (shape: Shape, prompt: "short" | "long", weight: number): LoadKind => ({
  name: `${shape}-${prompt}`,
  shape,
  prompt,
  stream: true,
  model: defaultModels[shape],
  weight,
  ttfbProfileMs: profileMs[prompt],
});

/** The short answer streamed in rotation across the three protocols, and the long count. */
export const defaultMix: readonly LoadKind[] = [
  ...shapes.map((shape) => kind(shape, "short", 20)),
  ...shapes.map((shape) => kind(shape, "long", 5)),
];

export const defaultShape: LoadShape = {
  concurrency: 5,
  durationMs: 10 * 60_000,
  calls: undefined,
  ramp: undefined,
  maxAttempts: 4,
  attemptTimeoutMs: 5 * 60_000,
  mix: defaultMix,
};

const refuse = (field: string, rule: string): never => {
  throw new AcceptanceFailure(`POOL_LOAD_SHAPE ${field} must be ${rule}`);
};

function integer(input: JsonObject, field: string, min: number, max: number, fallback?: number) {
  const value = input[field] ?? fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    return refuse(field, `a whole number from ${min} to ${max}`);
  return value as number;
}

function parseKind(input: unknown, index: number): LoadKind {
  const at = `mix[${index}]`;
  if (!isObject(input)) return refuse(at, "an object");
  const shape = input.shape;
  if (!shapes.includes(shape as Shape)) return refuse(`${at}.shape`, "chat, responses or messages");
  const prompt = input.prompt ?? "short";
  if (prompt !== "short" && prompt !== "long") return refuse(`${at}.prompt`, "short or long");
  const stream = input.stream ?? true;
  if (typeof stream !== "boolean") return refuse(`${at}.stream`, "true or false");
  // The seam for unstreamed calls: data turns them on once shapes.mjs judges them.
  if (!stream && !nonStreamedVerdict)
    return refuse(`${at}.stream`, "true until the emulated shapes judge a non-streamed answer");
  const model = input.model ?? defaultModels[shape as Shape];
  if (typeof model !== "string" || !modelName.test(model))
    return refuse(`${at}.model`, "a model name the pool accepts");
  const name = input.name ?? `${shape}-${prompt}${stream ? "" : "-unstreamed"}`;
  if (typeof name !== "string" || !kindName.test(name))
    return refuse(`${at}.name`, "lowercase letters, digits and dashes");
  return {
    name,
    shape: shape as Shape,
    prompt,
    stream,
    model,
    weight: integer(input, "weight", 1, 1_000),
    ttfbProfileMs: integer(input, "ttfbProfileMs", 0, 60_000, profileMs[prompt]),
  };
}

/** The shape a dispatch asks for, as JSON; empty is the default warm baseline. */
export function parseLoadShape(text: string | undefined): LoadShape {
  if (!text?.trim()) return defaultShape;
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return refuse("", "JSON");
  }
  if (!isObject(input)) return refuse("", "a JSON object");
  const concurrency = integer(input, "concurrency", 1, 500, defaultShape.concurrency);
  const minutes = integer(input, "durationMinutes", 1, 120, defaultShape.durationMs / 60_000);
  let ramp: LoadRamp | undefined;
  if (input.ramp !== undefined) {
    if (!isObject(input.ramp)) return refuse("ramp", "an object");
    ramp = {
      from: integer(input.ramp, "from", 1, concurrency),
      step: integer(input.ramp, "step", 1, concurrency),
      intervalMs: integer(input.ramp, "intervalSeconds", 1, 3_600) * 1_000,
    };
  }
  const mix = input.mix ?? defaultMix;
  if (!Array.isArray(mix) || mix.length < 1 || mix.length > 20)
    return refuse("mix", "a list of 1 to 20 kinds");
  const kinds = input.mix === undefined ? defaultMix : mix.map(parseKind);
  if (new Set(kinds.map((entry) => entry.name)).size !== kinds.length)
    return refuse("mix", "kinds with distinct names");
  return {
    concurrency,
    durationMs: minutes * 60_000,
    calls: input.calls === undefined ? undefined : integer(input, "calls", 1, 1_000_000),
    ramp,
    maxAttempts: integer(input, "maxAttempts", 1, 10, defaultShape.maxAttempts),
    attemptTimeoutMs:
      integer(input, "attemptTimeoutSeconds", 10, 600, defaultShape.attemptTimeoutMs / 1_000) *
      1_000,
    mix: kinds,
  };
}

/** When worker `index` starts, from the run's start: the ramp's first workers at once. */
export function workerStartMs(shape: LoadShape, index: number) {
  const ramp = shape.ramp;
  if (!ramp || index < ramp.from) return 0;
  return Math.ceil((index - ramp.from + 1) / ramp.step) * ramp.intervalMs;
}

/** The mix's kinds in a smooth weighted rotation: every kind spread evenly, the same every run. */
export function kindRotation(mix: readonly LoadKind[]) {
  const total = mix.reduce((sum, entry) => sum + entry.weight, 0);
  const current = mix.map(() => 0);
  return () => {
    let best = 0;
    for (const [index, entry] of mix.entries()) {
      current[index]! += entry.weight;
      if (current[index]! > current[best]!) best = index;
    }
    current[best]! -= total;
    return mix[best]!;
  };
}

/** A kill time given as epoch milliseconds or an ISO time; anything else is no time. */
export function killTime(value: string | undefined) {
  const text = value?.trim();
  if (!text) return undefined;
  const at = /^\d{13}$/u.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(at) ? at : undefined;
}
