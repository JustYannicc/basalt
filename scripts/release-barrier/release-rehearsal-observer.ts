import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
/** The controller reads these checks need; a release client provides them. */
type AdoptedReader = { inspect(): Promise<{ selection?: unknown; policies: unknown }> };
type FleetReader = {
  fleet(): Promise<{
    permission?: {
      configuration: {
        active: string;
        applications: readonly { color: string; applicationId: string }[];
      };
    };
  }>;
  inspect(): Promise<{ selection?: { active: { target: { applicationId: string } } } }>;
};
import { BarrierRefusal } from "./refusal.ts";
import { rehearsalStop, releaseTarget, type RehearsalStop } from "./release-stage.ts";

/**
 * Ends a rehearsal's first release right after adopt, leaving the state a failed release left. The
 * controller's snapshot at that point is what the rehearsal checks against production's shape.
 */
export async function stopAfterAdopt(
  client: AdoptedReader,
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (rehearsalStop(env) !== "after-adopt") return;
  const snapshot = await client.inspect();
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "rehearsal-adopted.json"),
    `${JSON.stringify({ selection: snapshot.selection, policies: snapshot.policies })}\n`,
    { mode: 0o600 },
  );
  throw new BarrierRefusal("release-rehearsal-stopped-after-adopt", "PoolWorker");
}

/**
 * Ends a rehearsal's release at a bootstrap or bind point, which no abort or settlement accepts:
 * the rehearsal re-dispatches the same candidate from there, as production would have to.
 */
export function stopAt(point: RehearsalStop, env: NodeJS.ProcessEnv = process.env) {
  if (rehearsalStop(env) === point)
    throw new BarrierRefusal(`release-rehearsal-stopped-${point}`, "PoolWorker");
}

/**
 * Ends a rehearsal's release once the candidate startup is journaled and staged, before the
 * promotion gate: the one point where the runtime abort can still act on the staged candidate.
 */
export function stopBeforePromotionGate(env: NodeJS.ProcessEnv = process.env) {
  if (rehearsalStop(env) === "before-promotion-gate")
    throw new BarrierRefusal("release-rehearsal-stopped-before-promotion-gate", "PoolWorker");
}

/** After promote, the fleet permission names the color the selection now serves from. */
export async function assertRehearsalFleetActive(
  client: FleetReader,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!releaseTarget(env).rehearsal) return;
  const [fleet, snapshot] = await Promise.all([client.fleet(), client.inspect()]);
  const configuration = fleet.permission?.configuration;
  const active = snapshot.selection?.active.target.applicationId;
  const color = configuration?.applications.find((app) => app.applicationId === active)?.color;
  if (!configuration || !color || configuration.active !== color)
    throw new BarrierRefusal("release-rehearsal-fleet-active-mismatch", "PoolWorker");
}

/** Records how long a rehearsal waited on a release observation; production records nothing. */
export async function timeRehearsalWait<A>(
  directory: string,
  name: string,
  wait: () => Promise<A>,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now,
): Promise<A> {
  if (!releaseTarget(env).rehearsal) return wait();
  const started = now();
  let outcome = "refused";
  try {
    const value = await wait();
    outcome = "observed";
    return value;
  } finally {
    await mkdir(directory, { recursive: true });
    await appendFile(
      resolve(directory, "rehearsal-waits.jsonl"),
      `${JSON.stringify({ name, outcome, milliseconds: now() - started })}\n`,
      { mode: 0o600 },
    );
  }
}
