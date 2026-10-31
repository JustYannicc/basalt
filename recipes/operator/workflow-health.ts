import type { WorkflowStepContext } from "apps";
import { requirements } from "../common/installation.ts";
import { configuration } from "../common/configuration.ts";
import { api, instant, list, numeric, record, text, tool } from "../common/api.ts";
import type { Observation } from "../common/types.ts";
import { workflowHealthCondition, type ScanRun } from "./workflow-health-condition.ts";
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
  try {
    for (const watched of configuration.operator.workflowApps) {
      const health = record(
        await tool(step, { app: watched.app, tool: "deliveryHealth", input: {} }),
      );
      const configuredAt = numeric(health?.configuredAt);
      if (
        health?.current !== true ||
        health.complete !== true ||
        configuredAt === undefined ||
        !Array.isArray(health.deliveries)
      )
        return observation(now, "unknown", "workflow-health-incomplete");
      const deliveries = health.deliveries.map((value) => {
        const delivery = record(value);
        return { status: text(delivery?.status) ?? "unknown", at: numeric(delivery?.at) ?? 0 };
      });
      const runs: ScanRun[] = [];
      let cursor = "",
        count = 0;
      do {
        const response = record(
          await api(
            step,
            "GET",
            `apps/${encodeURIComponent(watched.app)}/workflow-runs?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        );
        if (!Array.isArray(response?.items))
          return observation(now, "unknown", "workflow-history-unavailable");
        for (const value of response.items) {
          const run = record(value),
            workflow = text(run?.workflow),
            at = instant(run?.createdAt);
          if (!workflow || at === undefined) continue;
          const output = record(run?.output);
          runs.push({
            workflow,
            at,
            status: text(run?.status) ?? "unknown",
            outcome: text(output?.status),
            delivery: text(output?.delivery),
          });
        }
        count += response.items.length;
        const next = text(response.next) ?? "";
        if ((next && next === cursor) || (next && count >= 1000))
          return observation(now, "unknown", "workflow-history-incomplete");
        cursor = next;
      } while (cursor);
      const result = workflowHealthCondition(
        now,
        configuredAt,
        watched.workflows,
        runs,
        deliveries,
      );
      if (result === "action") return observation(now, "action", "workflow-check-failed");
      unknown ||= result === "unknown";
    }
    return observation(
      now,
      unknown ? "unknown" : "healthy",
      unknown ? "no-confirmed-scans" : "workflow-check-healthy",
    );
  } catch {
    return observation(now, "unknown", "workflow-history-unavailable");
  }
}
