import type { RuntimeProviderReader } from "../runtime-provider/read.ts";
import { SlotRefused } from "./contract.ts";
import type { RetirementProvider } from "./retirement.ts";
import type { StartupStopRecord } from "./startup-abort-contract.ts";

/**
 * The driver's own report that this boot stopped; only it lets an inactive listing count as gone.
 * Neither release here gives a counted set: nothing quarantines them at a time bound, so waiting
 * while any other instance may start or stop costs them nothing.
 */
const driverStopped = { driverStopped: true } as const;

/** The retained admission names the application even after current release bindings advance. */
export function primaryRetirementProvider(reader: RuntimeProviderReader): RetirementProvider {
  return async (phase, observation) => {
    if (!observation.provider) throw new SlotRefused("uncertain");
    const target = { ...observation.identity, ...observation.provider };
    if (phase === "present") {
      await reader.observe("root_retire", target, observation.identity.instanceId);
      return;
    }
    const stopped = observation.retired && !observation.running ? driverStopped : undefined;
    if (!(await reader.absent(target, observation.identity.instanceId, undefined, stopped)))
      throw new SlotRefused("uncertain");
  };
}

export function startupAbortProvider(reader: RuntimeProviderReader) {
  return async (record: StartupStopRecord) => {
    // An aborted record is written only once the endpoint saw its container stopped.
    const stopped = record.status === "aborted" ? driverStopped : undefined;
    const target = { ...record.intent.target, ...record.provider };
    if (!(await reader.absent(target, record.intent.target.instanceId, undefined, stopped)))
      throw new SlotRefused("uncertain");
  };
}
