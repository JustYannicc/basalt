import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  acceptanceCredential,
  acceptanceDevice,
  AcceptanceDeviceRefused,
} from "../release/acceptance-device.ts";
import { PoolAcceptanceClient } from "./client.ts";
import { runLoad, summaryLines, type LoadRun } from "./load.ts";
import { killTime, parseLoadShape } from "./load-shape.ts";
import { AcceptanceFailure, isAcceptancePool } from "./types.ts";

/** The coordinator's literal GO, as the fleet lane checks it (.github/workflows/pool-fleet.yml). */
export const goPattern = /^coordinator-20[0-9]{2}-[A-Za-z0-9-]{1,96}$/u;
// A marker is written once the kill is answered, which can be after the last call ends.
const markerWaitMs = 120_000;

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

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/**
 * The load mode: refuses on a missing GO, a bad shape or kill input, or a device outside an
 * acceptance pool before any credential is read. Each call goes to `calls.jsonl` as it ends; the
 * calls a kill moved into its own class go to `in-flight.jsonl`, the verdict to `run.json` and the
 * public summary to `summary.txt`, all written however the run ends. Says whether the run passed.
 */
export async function runLoadFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  client: PoolAcceptanceClient = new PoolAcceptanceClient(),
  log: (text: string) => void = console.log,
): Promise<boolean> {
  if (!goPattern.test(env.POOL_LOAD_GO ?? ""))
    throw new AcceptanceFailure("Load mode needs a go input matching ^coordinator-20YY-");
  const shape = parseLoadShape(env.POOL_LOAD_SHAPE);
  const kill = killSource(env);
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
  let run: LoadRun | undefined;
  let failure: string | undefined;
  try {
    run = await runLoad({
      client,
      credential,
      shape,
      kill: kill?.read,
      killWaitMs: kill?.waitMs,
      ended: (call) => writeSync(calls, line(call)),
    });
  } catch (error) {
    failure = error instanceof Error ? error.constructor.name || "Error" : "unknown";
  } finally {
    closeSync(calls);
  }
  const lines = run
    ? summaryLines(run, shape)
    : [`load status=failed error=${failure}`, "load calls=see_calls.jsonl"];
  writeFileSync(
    join(directory, "in-flight.jsonl"),
    (run?.calls ?? []).flatMap((call) => (call.inFlight ? [line(call)] : [])).join(""),
  );
  writeFileSync(
    join(directory, "run.json"),
    `${JSON.stringify({ shape, killAt: run?.killAt, verdict: run?.verdict, error: failure }, null, 2)}\n`,
  );
  writeFileSync(join(directory, "summary.txt"), `${lines.join("\n")}\n`);
  for (const text of lines) log(text);
  return run?.verdict.passed ?? false;
}
