import { Schema } from "effect";
import { deploymentReadinessPrefix } from "./deployment-readiness.ts";
import { RuntimeCrashAuthorization, targetsCell } from "./runtime-crash-contract.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { openEnvelope } from "./token.ts";

export const homeTopologyPath = "/v8/management/topology";

const Topology = Schema.Struct({
  summary: Schema.Struct({ missing_master: Schema.Boolean }),
  management: Schema.Struct({ home_id: Schema.NonEmptyString }),
  homes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      role: Schema.String,
      is_master: Schema.Boolean,
      reported_master: Schema.Boolean,
    }),
  ),
});
export type HomeCrashRefusal =
  | "master"
  | "reported_master"
  | "missing_master"
  | "home_unknown"
  | "topology_unreadable";
/**
 * One Home heartbeat is 5 s and the read is local to the runtime, so a healthy Home answers well
 * inside a second. A slower one counts as unreadable, which refuses the kill.
 */
const topologyReadTimeoutMs = 1_000;

/** The owner verifies the envelope. An unreadable one counts as a cell, so the check still runs. */
export async function crashTargetsCell(secret: string, envelope: string) {
  try {
    const opened = await openEnvelope(secret, deploymentReadinessPrefix, envelope);
    return targetsCell(Schema.decodeUnknownSync(RuntimeCrashAuthorization)(opened).command);
  } catch {
    return true;
  }
}

/**
 * Only the elected master Home refreshes provider tokens, so only a kill there can land between a
 * provider rotating a token and Home storing it. Anything short of a proven follower refuses.
 */
export async function assertFollowerHome(
  target: "cell" | "primary",
  read: (signal: AbortSignal) => Promise<Response>,
) {
  let reason: HomeCrashRefusal | undefined;
  try {
    const response = await read(AbortSignal.timeout(topologyReadTimeoutMs));
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Home topology unavailable");
    }
    const topology = Schema.decodeUnknownSync(Topology)(await response.json());
    const own = topology.homes.filter((home) => home.id === topology.management.home_id);
    const home = own.length === 1 ? own[0] : undefined;
    if (home?.is_master || home?.role === "master") reason = "master";
    // The last heartbeat still claimed master, so its refresh loop may not have stopped yet.
    else if (home?.reported_master) reason = "reported_master";
    else if (topology.summary.missing_master) reason = "missing_master";
    else if (home?.role !== "follower") reason = "home_unknown";
  } catch {
    reason = "topology_unreadable";
  }
  if (!reason) return;
  console.warn("POOL_CRASH_REFUSED " + JSON.stringify({ target, reason }));
  throw new SlotRefused(
    reason === "topology_unreadable" || reason === "home_unknown" ? "uncertain" : "selection",
  );
}
