import type { WorkflowStepContext } from "apps";
import { requirements } from "../common/installation.ts";
import { configuration } from "../common/configuration.ts";
import { numeric, record, text, tool } from "../common/api.ts";
import type { Observation } from "../common/types.ts";
import { workflowHealthCondition } from "./workflow-health-condition.ts";
type Step = WorkflowStepContext<typeof requirements>;
const observation = (at: number, verdict: Observation["verdict"], code: string): Observation => ({
  cursor: `workflow-health:${at}`,
  at,
  verdict,
  code,
  failures: 0,
  successes: 0,
  since: at,
});
export async function readWorkflowHealth(step: Step): Promise<Observation> {
  const now = Date.now();
  if (!configuration.operator.workflowApps.length)
    return observation(now, "unknown", "workflow-watch-unconfigured");
  let unknown = false;
  for (const watched of configuration.operator.workflowApps) {
    try {
      const health = record(
        await tool(step, { app: watched.app, tool: "deliveryHealth", input: {} }),
      );
      const configuredAt = numeric(health?.configuredAt);
      if (
        health?.current !== true ||
        configuredAt === undefined ||
        !Array.isArray(health.deliveries) ||
        !Array.isArray(health.scans)
      ) {
        unknown = true;
        continue;
      }
      const deliveries = health.deliveries.map((value) => {
        const delivery = record(value);
        return { status: text(delivery?.status) ?? "unknown", at: numeric(delivery?.at) ?? 0 };
      });
      const scans = health.scans.map((value) => {
        const scan = record(value);
        return {
          workflow: text(scan?.workflow) ?? "",
          checkedAt: numeric(scan?.checkedAt) ?? 0,
          successfulAt: numeric(scan?.successfulAt) ?? 0,
          progressAt: numeric(scan?.progressAt) ?? 0,
          known: numeric(scan?.known) ?? 0,
        };
      });
      const result = workflowHealthCondition(
        now,
        configuredAt,
        watched.workflows,
        scans,
        deliveries,
        health.complete === true && scans.length <= 1000,
      );
      if (result === "action") return observation(now, "action", "workflow-check-failed");
      unknown ||= result === "unknown";
    } catch {
      unknown = true;
    }
  }
  return observation(
    now,
    unknown ? "unknown" : "healthy",
    unknown ? "no-confirmed-scans" : "workflow-check-healthy",
  );
}
