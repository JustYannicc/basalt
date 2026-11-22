import { PoolAcceptanceClient, type ModelAuth } from "../pool-acceptance/client.ts";
import { AcceptanceFailure, HttpStatusFailure } from "../pool-acceptance/types.ts";
import { deviceRefusal, refusedDevice } from "./acceptance-device.ts";
import {
  healingAcceptanceWithinMs,
  healingReadinessWithinMs,
} from "../../src/pool/runtime-slots/forced-restart-timing.ts";

/**
 * How long a healing release waits for recovery on a new boot. After a failed apply, readiness
 * never proved that the controller object adopted the new code, so the wait budgets that adoption
 * too. It ends at the first ready read either way.
 */
export function healingWait(applyOutcome: string | undefined) {
  return applyOutcome === "failure"
    ? { name: "healingReadinessWithinMs", seconds: healingReadinessWithinMs / 1_000 }
    : { name: "healingAcceptanceWithinMs", seconds: healingAcceptanceWithinMs / 1_000 };
}

/**
 * The release's own acceptance through the public pool: one warm-up, a concurrent burst, one final
 * request, all streamed. Any failed request fails the release (an intermittent error is a stop).
 * Each response names the runtime that served it (X-Signalbox-Pool-Boot), so a release can also
 * require that the root kept its boot (code-only) or that a fleet cell served (fleet).
 */
export interface AcceptanceOptions {
  /** The acceptance device's per-request signer; release acceptance never sends a bearer key. */
  readonly credential: ModelAuth;
  readonly model?: string;
  readonly burst?: number;
  readonly expect: "same-boot" | "two-runtimes" | "any";
  /**
   * This run's boot read before the apply did not refuse the acceptance device. A 401 or 403 after
   * it is then a serving failure, not an untested release: the release is the likeliest thing that
   * changed. A model turn's 429 with the pool's cap code is its user's cap either way.
   */
  readonly admitted?: boolean;
  /** The root's boot read before the apply: no release may restart the root, whatever it serves. */
  readonly rootBoot?: string;
  readonly client?: PoolAcceptanceClient;
}

/** The boot of the runtime serving the pool now: the root while no fleet cell serves. */
export async function servingBoot(credential: ModelAuth, client = new PoolAcceptanceClient()) {
  return (await client.modelCatalog(credential)).boot;
}

/** Recorded before the apply of a release that declares a root restart, when the pool did not answer. */
export const NOT_SERVING = "not-serving";

/**
 * The models acceptance tests with, in order: the ones test turns use, which the pool's accounts
 * serve. Acceptance never takes whatever the catalog lists first: the catalog is the runtime's own
 * list, unchecked against what an account can serve, and on 22 Nov its first id was a model the
 * provider refused on every turn, so a sound release failed its acceptance and rolled back.
 */
export const acceptanceModels = ["claude-opus-5-5", "gpt-6.1-sol"] as const;

/** A configured model if the catalog lists it, else the first of `acceptanceModels` it lists. */
export function acceptanceModel(ids: readonly string[], configured?: string) {
  if (configured) {
    if (!ids.includes(configured))
      throw new Error(`The acceptance model ${configured} is not in /v1/models`);
    return configured;
  }
  const model = acceptanceModels.find((id) => ids.includes(id));
  if (!model)
    throw new Error(`None of the acceptance models (${acceptanceModels.join(", ")}) is in /v1/models`);
  return model;
}

/** Why one turn failed, in words that name no host: our own messages and the pool's status. */
const turnFailure = (error: unknown) =>
  error instanceof HttpStatusFailure
    ? `HTTP ${error.status}`
    : error instanceof AcceptanceFailure
      ? error.message
      : "no answer";

/**
 * Before the apply: the model acceptance will test with, and one real turn with it. A model the pool
 * lists but cannot serve fails every turn, and after the apply that reads as the release failing and
 * rolls it back; one turn here stops such a run before anything changes. It spends one model call,
 * in a plan too.
 */
export async function acceptanceModelBeforeApply(
  credential: ModelAuth,
  client: PoolAcceptanceClient,
  configured?: string,
) {
  const ids = await client.modelCatalog(credential).then(
    (catalog) => catalog.ids,
    (error: unknown) => {
      throw new Error(
        `/v1/models did not answer before the apply (${turnFailure(error)}); nothing was applied`,
        { cause: error },
      );
    },
  );
  const model = acceptanceModel(ids, configured);
  try {
    await client.sendTurn(credential, model, {
      id: crypto.randomUUID().toLowerCase(),
      expectedRecords: 1,
    });
  } catch (error) {
    throw new Error(
      `The acceptance model ${model} did not serve one turn before the apply (${turnFailure(error)}); nothing was applied`,
      { cause: error },
    );
  }
  return model;
}

/**
 * The boot read before the apply. A refused device is never "not serving": nothing could accept the
 * release after it either, so the run stops here, before anything changes.
 */
export async function bootBeforeApply(
  credential: ModelAuth,
  client: PoolAcceptanceClient,
  allowNotServing: boolean,
) {
  try {
    return await servingBoot(credential, client);
  } catch (error) {
    const refused = deviceRefusal(error);
    if (refused !== undefined) throw refusedDevice(refused);
    if (allowNotServing) return NOT_SERVING;
    throw error;
  }
}

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
  return unfinished(
    `not ready within ${Math.round(options.withinMs / 1000)} s of acceptance's start`,
  );
}

/**
 * A healing release ends in one of four outcomes. Healed: recovery ready on a new boot, and every
 * model call served. Serving, needs a person: a new boot is selected and every model call served,
 * but recovery needs a person or did not report ready within the bound; nothing is undone, and a
 * person looks at it with the pool serving. Could not test: a new boot is selected, but the pool
 * refused the acceptance device on its user's cap. Not serving: anything else, a refusal of the
 * device included, since this run's boot read before the apply did not refuse it.
 */
export type HealingOutcome = "healed" | "serving-needs-person" | "could-not-test" | "not-serving";
export const healingOutcome = (
  verdict: RecoveryVerdict,
  calls: { readonly passed: boolean; readonly couldNotTest?: boolean } | undefined,
): HealingOutcome =>
  !verdict.boot
    ? "not-serving"
    : calls?.couldNotTest
      ? "could-not-test"
      : !calls?.passed
        ? "not-serving"
        : verdict.ready
          ? "healed"
          : "serving-needs-person";

export interface AcceptanceResult {
  readonly passed: boolean;
  /**
   * The pool refused the acceptance device and nothing failed to serve, so nothing was tested:
   * the run stops red without undoing a release nobody saw fail.
   */
  readonly couldNotTest: boolean;
  /** The HTTP statuses of the pool's refusals of the device, once each. */
  readonly refused: readonly number[];
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

const refusedFor = (statuses: readonly number[]) =>
  `refused for the acceptance device (HTTP ${statuses.join(", ")})`;
/** A request the pool refused after this run's boot read admitted the device: a serving failure. */
const refusedAfterAdmission = (error: unknown) =>
  `${error instanceof Error ? error.message : String(error)}: refused the acceptance device this run's boot read admitted`;

export async function runAcceptance(options: AcceptanceOptions): Promise<AcceptanceResult> {
  const client = options.client ?? new PoolAcceptanceClient();
  const requests = (options.burst ?? 25) + 2;
  // The pool refusing the device tested nothing, unless this run's boot read admitted it. A 429 is
  // a refusal only with the pool's cap code (deviceRefusal), and the cap is the user's, not the
  // release's.
  const testedNothing = (status: number) => status === 429 || !options.admitted;
  let catalog;
  try {
    catalog = await client.modelCatalog(options.credential);
  } catch (error) {
    // A catalog that does not answer is the pool not serving; a refused device tested nothing.
    const refused = deviceRefusal(error);
    if (refused === undefined) throw error;
    const untested = testedNothing(refused);
    const cause = untested
      ? `/v1/models was ${refusedFor([refused])}`
      : refusedAfterAdmission(error);
    return {
      passed: false,
      couldNotTest: untested,
      refused: untested ? [refused] : [],
      // Nothing was tested, or the one request it sent failed.
      requests: untested ? 0 : 1,
      failures: untested ? [] : [cause],
      boots: [],
      firstByteMs: { p50: 0, p95: 0 },
      cause,
    };
  }
  const model = acceptanceModel(catalog.ids, options.model);
  const failures: string[] = [];
  const refusals: number[] = [];
  const boots: string[] = [catalog.boot];
  const timings: number[] = [];
  const turn = async () => {
    try {
      const result = await client.sendTurn(options.credential, model, {
        id: crypto.randomUUID().toLowerCase(),
        expectedRecords: 1,
      });
      boots.push(result.boot);
      timings.push(result.firstByteMs);
    } catch (error) {
      const refused = deviceRefusal(error);
      if (refused !== undefined && testedNothing(refused)) refusals.push(refused);
      else if (refused !== undefined) failures.push(refusedAfterAdmission(error));
      else failures.push(error instanceof Error ? error.message : String(error));
    }
  };
  await turn();
  await Promise.all(Array.from({ length: options.burst ?? 25 }, turn));
  await turn();
  const distinct = [...new Set(boots)];
  const refused = [...new Set(refusals)].sort((a, b) => a - b);
  // What the served requests show decides first: a failed request, or a root that restarted.
  const servingCause = failures.length
    ? `${failures.length} of ${requests} requests failed: ${[...new Set(failures)].join("; ")}`
    : options.rootBoot !== undefined &&
        (!distinct.includes(options.rootBoot) ||
          (options.expect === "same-boot" && distinct.length !== 1))
      ? `The root restarted: boot ${options.rootBoot} before the apply, ${distinct.join(", ")} after`
      : options.expect === "same-boot" && distinct.length !== 1
        ? `The root changed boot during acceptance (${distinct.length} boots)`
        : undefined;
  const untested = refusals.length
    ? `${refusals.length} of ${requests} requests were ${refusedFor(refused)}`
    : undefined;
  const cause =
    servingCause ??
    untested ??
    (options.expect === "two-runtimes" && distinct.length < 2
      ? "Every request was served by one runtime; no fleet cell served"
      : undefined);
  return {
    passed: cause === undefined,
    couldNotTest: servingCause === undefined && untested !== undefined,
    refused,
    requests,
    failures,
    boots: distinct,
    firstByteMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95) },
    ...(cause ? { cause } : {}),
  };
}
