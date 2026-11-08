import type { PreparedWorkerUpload } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { Effect } from "effect";
import { placementRepairTargets } from "../pending-placement.ts";
import { placementRepairFixture } from "./placement-repair-fixture.ts";
import type { ActiveWorkerPlacement } from "../script-placement.ts";

export type CompanionMode = "numeric" | "repair" | "numeric-drift" | "retired";

export function classCompanion(mode: CompanionMode, events: string[]) {
  const numeric = mode === "numeric" || mode === "numeric-drift";
  const repair = placementRepairFixture(events, { numericPlacement: numeric });
  return {
    services: repair.services,
    retired: mode === "retired",
    prepare(upload: PreparedWorkerUpload) {
      return repair.prepare(upload);
    },
    baseline(scriptName: string) {
      return repair.baseline(scriptName);
    },
    placements(): Effect.Effect<ActiveWorkerPlacement[]> {
      return Effect.succeed([
        {
          id: placementRepairTargets[0].prior,
          placement: {
            mode: "targeted",
            target: [
              {
                id: 39,
                type: "region",
                region: mode === "numeric-drift" ? "aws:eu-west-1" : "aws:eu-central-1",
              },
            ],
          },
        },
      ]);
    },
    activate() {
      repair.activate("Api");
      events.push("companion-activate");
    },
  };
}
