import type { RuntimeProviderReader } from "../runtime-provider/read.ts";
import { SlotRefused } from "./contract.ts";
import type { RetirementProvider } from "./retirement.ts";

/** The retained admission names the application even after current release bindings advance. */
export function primaryRetirementProvider(reader: RuntimeProviderReader): RetirementProvider {
  return async (phase, observation) => {
    if (!observation.provider) throw new SlotRefused("uncertain");
    const target = { ...observation.identity, ...observation.provider };
    if (phase === "present") {
      await reader.observe(target, observation.identity.instanceId);
    } else if (!(await reader.absent(target, observation.identity.instanceId))) {
      throw new SlotRefused("uncertain");
    }
  };
}
