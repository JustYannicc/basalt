import { once } from "node:events";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  acceptanceCredential,
  acceptanceDevice,
  AcceptanceDeviceRefused,
} from "../release/acceptance-device.ts";
import { PoolAcceptanceClient } from "./client.ts";
import { verdictOf } from "./load-classes.ts";
import {
  errorKind,
  runLoad,
  stopKind,
  summaryLines,
  type EndedCall,
  type LoadRun,
} from "./load.ts";
import { killTime, parseLoadShape } from "./load-shape.ts";
import { mockWitness } from "./load-witness.ts";
import { AcceptanceFailure, isAcceptancePool } from "./types.ts";

/** Writes one JSON line per item, each its own write. */
function writeLines(path: string, items: readonly unknown[]) {
  const file = openSync(path, "w");
  try {
    for (const item of items) writeSync(file, line(item));
  } finally {
    closeSync(file);
  }
}

/** The coordinator's literal GO, as the fleet lane checks it (.github/workflows/pool-fleet.yml). */
export const goPattern = /^coordinator-20[0-9]{2}-[A-Za-z0-9-]{1,96}$/u;
// A marker is written once the kill is answered, which can be after the last call ends.
const markerWaitMs = 120_000;
// After a signal, how long calls in flight get to end and be recorded. A cancelled Actions job
// sends SIGINT, then SIGTERM about 7.5 s later, then kills.
const defaultStopWaitMs = 5_000;

/**
 * An input the dispatch left empty is unset; one that holds only spaces was meant to say something
 * and is refused, so a restart phase never runs as if no kill were armed.
 */
function given(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  if (!value.trim()) throw new AcceptanceFailure(`${name} holds only spaces`);
  return value.trim();
}

/** Where the restart phase's kill time comes from: a fixed time, or a marker file a kill writes. */
function killSource(env: NodeJS.ProcessEnv) {
  const fixed = given(env, "POOL_LOAD_KILL_AT");
  const marker = given(env, "POOL_LOAD_KILL_MARKER");
  if (fixed !== undefined) {
    const at = killTime(fixed);
    if (at === undefined)
      throw new AcceptanceFailure("POOL_LOAD_KILL_AT must be epoch milliseconds or an ISO time");
    return { read: () => at, waitMs: 0 };
  }
  if (marker === undefined) return undefined;
  const read = () => {
    try {
      return killTime(readFileSync(marker, "utf8"));
    } catch {
      return undefined;
    }
  };
  return { read, waitMs: markerWaitMs };
}

/**
 * The mock's own record of the run's sends: the stage Worker's origin and its key. Both are
 * required, so a run never relies on the driver's clock alone. Neither value reaches any line.
 */
function witnessSource(env: NodeJS.ProcessEnv, fetcher?: typeof fetch) {
  const origin = given(env, "POOL_LOAD_WITNESS_ORIGIN");
  const key = given(env, "POOL_LOAD_WITNESS_KEY");
  if (origin === undefined || key === undefined)
    throw new AcceptanceFailure(
      "Load mode needs POOL_LOAD_WITNESS_ORIGIN and POOL_LOAD_WITNESS_KEY: the mock's own send record is the run's second witness",
    );
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new AcceptanceFailure("POOL_LOAD_WITNESS_ORIGIN must be an origin");
  }
  // A plain-HTTP origin is only for a mock on this machine, as the tests run one.
  const local = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if ((url.protocol !== "https:" && !local) || url.pathname !== "/" || url.search || url.username)
    throw new AcceptanceFailure("POOL_LOAD_WITNESS_ORIGIN must be an https origin with no path");
  return mockWitness({ origin: url.origin, key, fetch: fetcher });
}

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/**
 * The load mode: refuses on a missing GO, a bad shape, kill or witness input, or a device outside
 * an acceptance pool before any credential is read. Each call goes to `calls.jsonl` as it ends, by
 * the driver's own measure; each call as both witnesses judged it to `judged.jsonl`, the mock's
 * records to `witness.jsonl`, the calls a kill moved into its own class to `in-flight.jsonl`, the
 * verdict to `run.json` and the public summary to `summary.txt`, all written however the run ends,
 * a `stop` included: then no
 * call starts, calls in flight get `stopWaitMs` to end, and the run is reported as failed with
 * whatever ended. Says whether the run passed.
 */
export async function runLoadFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  client: PoolAcceptanceClient = new PoolAcceptanceClient(),
  log: (text: string) => void = console.log,
  {
    stop,
    stopWaitMs = defaultStopWaitMs,
    witnessFetch,
  }: { stop?: AbortSignal; stopWaitMs?: number; witnessFetch?: typeof fetch } = {},
): Promise<boolean> {
  if (!goPattern.test(env.POOL_LOAD_GO ?? ""))
    throw new AcceptanceFailure("Load mode needs a go input matching ^coordinator-20YY-");
  const shape = parseLoadShape(env.POOL_LOAD_SHAPE);
  const kill = killSource(env);
  const witness = witnessSource(env, witnessFetch);
  let credential;
  try {
    // Load spends the accounts of the device's pool, so it runs only in a pool made for acceptance.
    // It reads no usage, so it never mints an owner token at all.
    if (!isAcceptancePool(acceptanceDevice(env).pool))
      throw new AcceptanceFailure(
        "Load runs only through a dedicated acceptance-<run> pool; POOL_ACCEPTANCE_DEVICE names another pool",
      );
    credential = acceptanceCredential(env);
  } catch (error) {
    if (error instanceof AcceptanceDeviceRefused)
      throw new AcceptanceFailure(`${error.field}: ${error.why}; ${error.fix}`);
    throw error;
  }
  const directory = env.POOL_LOAD_OUTPUT_DIRECTORY?.trim() || join(".local", "pool-load");
  mkdirSync(directory, { recursive: true });
  // Written synchronously as each call ends: a cancelled job keeps every call that finished.
  const calls = openSync(join(directory, "calls.jsonl"), "w");
  const ended: EndedCall[] = [];
  let open = true;
  const running = runLoad({
    client,
    credential,
    shape,
    kill: kill?.read,
    killWaitMs: kill?.waitMs,
    stop,
    witness,
    ended: (call) => {
      ended.push(call);
      // A call that outlives a stop's wait ends after the record closed: it is not written.
      if (open) writeSync(calls, line(call));
    },
  });
  // Past the stop's wait the run is reported from what ended; the calls still out are not waited on.
  const settled = new AbortController();
  const waited = stop
    ? (stop.aborted ? Promise.resolve() : once(stop, "abort", { signal: settled.signal }))
        .then(() => sleep(stopWaitMs, undefined, { signal: settled.signal }))
        .catch(() => undefined)
    : new Promise<never>(() => {});
  let run: LoadRun | undefined;
  let failure: string | undefined;
  try {
    run = await Promise.race([running, waited]);
  } catch (error) {
    failure = errorKind(error);
  } finally {
    settled.abort();
    running.catch(() => {});
    open = false;
    closeSync(calls);
  }
  if (!run) {
    const killAt = kill?.read();
    const error = failure ?? (stop ? stopKind(stop) : "unknown");
    const firstFailure = ended.find((call) => !call.pass)?.call;
    run = {
      calls: ended,
      killAt,
      verdict: verdictOf(ended, firstFailure, { armed: kill !== undefined, at: killAt }, error),
    };
  }
  const lines = summaryLines(run, shape);
  writeFileSync(
    join(directory, "in-flight.jsonl"),
    run.calls.flatMap((call) => (call.inFlight ? [line(call)] : [])).join(""),
  );
  // Each call as both witnesses judged it, and the mock's own records they were judged on, a line
  // at a time: a run of a million calls is past the longest string one join may build.
  writeLines(join(directory, "judged.jsonl"), run.calls);
  writeLines(join(directory, "witness.jsonl"), run.sends ?? []);
  writeFileSync(
    join(directory, "run.json"),
    `${JSON.stringify({ shape, killAt: run.killAt, verdict: run.verdict }, null, 2)}\n`,
  );
  writeFileSync(join(directory, "summary.txt"), `${lines.join("\n")}\n`);
  for (const text of lines) log(text);
  return run.verdict.passed;
}
