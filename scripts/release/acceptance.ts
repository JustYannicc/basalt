import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";

/**
 * The release's own acceptance through the public pool: one warm-up, a concurrent burst, one final
 * request, all streamed. Any failed request fails the release (an intermittent error is a stop).
 * Each response names the runtime that served it (X-Signalbox-Pool-Boot), so a release can also
 * require that the root kept its boot (code-only) or that a fleet cell served (fleet).
 */
export interface AcceptanceOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly burst?: number;
  readonly expect: "same-boot" | "two-runtimes" | "any";
  /** The root's boot read before the apply: no release may restart the root, whatever it serves. */
  readonly rootBoot?: string;
  readonly client?: PoolAcceptanceClient;
}

/** The boot of the runtime serving the pool now: the root while no fleet cell serves. */
export async function servingBoot(apiKey: string, client = new PoolAcceptanceClient()) {
  return (await client.modelCatalog(apiKey)).boot;
}

/** Recorded before the apply of a release that declares a root restart, when the pool did not answer. */
export const NOT_SERVING = "not-serving";

/** What the controller's signed read-only `inspect` says about the active runtime and its recovery. */
export function recoveryState(result: unknown) {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const selection = record(result) && record(result.selection) ? result.selection : undefined;
  const active = selection && record(selection.active) ? selection.active : undefined;
  const identity = active && record(active.identity) ? active.identity : undefined;
  const recovery = record(result) && record(result.recovery) ? result.recovery : undefined;
  const needsPerson = recovery?.needsPerson;
  const present = Object.entries(recovery ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key]) => key)
    .filter((key) => /^[A-Za-z][A-Za-z0-9]{0,40}$/u.test(key))
    .sort();
  return {
    // Field names only, never values: what the last read said, for a stop that has to name it.
    fields: present,
    // A forced stop waits while the stuck runtime counts in-flight streams, until the count stands
    // still (`leakedStreamsMs`).
    waitingForStreams: present.some((key) => /stream/iu.test(key)),
    bootId: typeof identity?.bootId === "string" ? identity.bootId : undefined,
    // The forced stop sets it, and recovery clears it when it reports `ready`.
    restarting: recovery?.restartedAt !== undefined && recovery.restartedAt !== null,
    needsPerson:
      needsPerson === undefined || needsPerson === null
        ? undefined
        : typeof needsPerson === "string" && /^[a-z0-9_-]{1,64}$/u.test(needsPerson)
          ? needsPerson
          : "present",
  };
}

/** What the bounded wait for the controller's recovery found. */
export type RecoveryVerdict =
  | {
      readonly ready: true;
      readonly boot: string;
      readonly waitedMs: number;
      readonly reads: number;
    }
  | {
      readonly ready: false;
      /** The new boot the controller selected at its last answer, when it selected one. */
      readonly boot?: string;
      /** Why recovery did not report ready: its needs-a-person code, or the bound. */
      readonly reason: string;
      /** The last read, by field names only. */
      readonly last: string;
      readonly waitedMs: number;
      readonly reads: number;
    };

/**
 * A healing release: wait, bounded, until the controller's recovery reports `ready` on a boot other
 * than the stuck one. `/v1/models` is no signal: it answers while model calls are still refused,
 * until a membership pass renews the pool's policy. Ready is all three of: a new active boot, no
 * `recovery.restartedAt`, no `recovery.needsPerson`. A new boot whose recovery needs a person ends
 * the wait at once; the model calls then say whether the pool serves. On the stuck boot it does not:
 * that can be the state the release came to heal.
 */
export async function awaitRecoveryReady(options: {
  readonly inspect: () => Promise<unknown>;
  /** The active boot read before the apply, or NOT_SERVING. */
  readonly before: string;
  readonly withinMs: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}): Promise<RecoveryVerdict> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  const interval = options.intervalMs ?? 5_000;
  const started = now();
  let last = "no read";
  let reads = 0;
  let selected: string | undefined;
  const unfinished = (reason: string) => ({
    ready: false as const,
    ...(selected ? { boot: selected } : {}),
    reason,
    last,
    waitedMs: now() - started,
    reads,
  });
  while (now() - started <= options.withinMs) {
    reads++;
    try {
      const state = recoveryState(await options.inspect());
      selected = state.bootId && state.bootId !== options.before ? state.bootId : undefined;
      last = state.waitingForStreams
        ? "waiting for in-flight streams to stand still (up to 5 min)"
        : !state.bootId
          ? "no active boot"
          : !selected
            ? "still the stuck boot"
            : "a new boot, recovery not ready";
      if (state.fields.length) last += `; recovery fields: ${state.fields.join(", ")}`;
      if (selected && state.needsPerson) return unfinished(`needs a person (${state.needsPerson})`);
      if (selected && !state.restarting)
        return { ready: true, boot: selected, waitedMs: now() - started, reads };
    } catch (error) {
      // A refusal or a dropped read while the runtime restarts; messages can name hosts.
      last = `no answer (${error instanceof Error ? ((error as { reason?: string }).reason ?? error.name) : "unknown"})`;
    }
    await sleep(interval);
  }
  return unfinished(`not ready within ${Math.round(options.withinMs / 1000)} s of the apply`);
}

/**
 * A healing release ends in one of three outcomes. Healed: recovery ready on a new boot, and every
 * model call served. Serving, needs a person: a new boot is selected and every model call served,
 * but recovery needs a person or did not report ready within the bound; nothing is undone, and a
 * person looks at it with the pool serving. Not serving: anything else.
 */
export type HealingOutcome = "healed" | "serving-needs-person" | "not-serving";
export const healingOutcome = (
  verdict: RecoveryVerdict,
  calls: { readonly passed: boolean } | undefined,
): HealingOutcome =>
  !verdict.boot || !calls?.passed
    ? "not-serving"
    : verdict.ready
      ? "healed"
      : "serving-needs-person";

export interface AcceptanceResult {
  readonly passed: boolean;
  readonly requests: number;
  readonly failures: readonly string[];
  readonly boots: readonly string[];
  readonly firstByteMs: { readonly p50: number; readonly p95: number };
  readonly cause?: string;
}

const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!);
};

export async function runAcceptance(options: AcceptanceOptions): Promise<AcceptanceResult> {
  const client = options.client ?? new PoolAcceptanceClient();
  const catalog = await client.modelCatalog(options.apiKey);
  const model = options.model ?? catalog.ids[0];
  if (!model || !catalog.ids.includes(model))
    throw new Error("The acceptance model is not in /v1/models");
  const failures: string[] = [];
  const boots: string[] = [catalog.boot];
  const timings: number[] = [];
  const turn = async () => {
    try {
      const result = await client.sendTurn(options.apiKey, model, {
        id: crypto.randomUUID().toLowerCase(),
        expectedRecords: 1,
      });
      boots.push(result.boot);
      timings.push(result.firstByteMs);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  };
  await turn();
  await Promise.all(Array.from({ length: options.burst ?? 25 }, turn));
  await turn();
  const distinct = [...new Set(boots)];
  const cause = failures.length
    ? `${failures.length} of ${(options.burst ?? 25) + 2} requests failed: ${[...new Set(failures)].join("; ")}`
    : options.rootBoot !== undefined &&
        (!distinct.includes(options.rootBoot) ||
          (options.expect === "same-boot" && distinct.length !== 1))
      ? `The root restarted: boot ${options.rootBoot} before the apply, ${distinct.join(", ")} after`
      : options.expect === "same-boot" && distinct.length !== 1
        ? `The root changed boot during acceptance (${distinct.length} boots)`
        : options.expect === "two-runtimes" && distinct.length < 2
          ? "Every request was served by one runtime; no fleet cell served"
          : undefined;
  return {
    passed: cause === undefined,
    requests: (options.burst ?? 25) + 2,
    failures,
    boots: distinct,
    firstByteMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95) },
    ...(cause ? { cause } : {}),
  };
}
