import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  acceptanceCredential,
  acceptanceDevice,
  AcceptanceDeviceRefused,
} from "../release/acceptance-device.ts";
import { PoolAcceptanceClient } from "./client.ts";
import { runLoad, summaryLines } from "./load.ts";
import { killTime, parseLoadShape } from "./load-shape.ts";
import { AcceptanceFailure, isAcceptancePool } from "./types.ts";

/** The coordinator's literal GO, as the fleet lane checks it (.github/workflows/pool-fleet.yml). */
export const goPattern = /^coordinator-20[0-9]{2}-[A-Za-z0-9-]{1,96}$/u;
// A marker is written once the kill is answered, which can be after the last call ends.
const markerWaitMs = 120_000;

/** Where the restart phase's kill time comes from: a fixed time, or a marker file a kill writes. */
function killSource(env: NodeJS.ProcessEnv) {
  const fixed = env.POOL_LOAD_KILL_AT?.trim();
  if (fixed) {
    const at = killTime(fixed);
    if (at === undefined)
      throw new AcceptanceFailure("POOL_LOAD_KILL_AT must be epoch milliseconds or an ISO time");
    return { read: () => at, waitMs: 0 };
  }
  const marker = env.POOL_LOAD_KILL_MARKER?.trim();
  if (!marker) return undefined;
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
 * The load mode: refuses on a missing GO, a bad shape or a device outside an acceptance pool before
 * any credential is read, then runs, writes every call to `calls.jsonl` and the public summary to
 * `summary.txt`, and says whether the run passed.
 */
export async function runLoadFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  client: PoolAcceptanceClient = new PoolAcceptanceClient(),
  log: (line: string) => void = console.log,
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
  const run = await runLoad({
    client,
    credential,
    shape,
    kill: kill?.read,
    killWaitMs: kill?.waitMs,
  });
  const lines = summaryLines(run, shape);
  const directory = env.POOL_LOAD_OUTPUT_DIRECTORY?.trim() || join(".local", "pool-load");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "calls.jsonl"),
    run.calls.map((call) => `${JSON.stringify(call)}\n`).join(""),
  );
  await writeFile(
    join(directory, "run.json"),
    `${JSON.stringify({ shape, killAt: run.killAt, verdict: run.verdict }, null, 2)}\n`,
  );
  await writeFile(join(directory, "summary.txt"), `${lines.join("\n")}\n`);
  for (const line of lines) log(line);
  return run.verdict.passed;
}
