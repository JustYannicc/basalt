import type { PreparedWorkerUpload } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import type { CompiledStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { Effect } from "effect";
import type { DeployStackOptions } from "./deploy-stack.ts";
import { readActivePlacements, readBaseline, readCurrentDeployment } from "./cloudflare.ts";
import { readVersionPlacement } from "./active-placement-read.ts";
import { pendingPlacementRepair, placementRepairTargets } from "./pending-placement.ts";
import { retiredPlacements } from "./placement-retirement.ts";
import { needsPlacementProof } from "./script-placement.ts";
import { withOperation } from "./operation-failure.ts";

/** Class preflight and candidate admission must use the same exact serving-version proof. */
export const observeWorkerBaselines = (
  captured: ReadonlyMap<string, PreparedWorkerUpload>,
  stack: Pick<CompiledStack, "name" | "stage">,
  io?: DeployStackOptions["io"],
) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const retired = yield* retiredPlacements(state, stack);
    const entries = yield* Effect.forEach(
      [...captured.values()],
      (upload) =>
        Effect.gen(function* () {
          const baseline = yield* (io?.baseline ?? readBaseline)(upload.request);
          const repairTarget = placementRepairTargets.find(
            (target) =>
              target.role === upload.fqn &&
              target.scriptName === upload.request.scriptName &&
              baseline.some((version) => version.versionId === target.version),
          );
          const versions =
            repairTarget || needsPlacementProof(upload.previousSettings?.placement)
              ? yield* (io?.placements ?? readActivePlacements)(upload.request, baseline)
              : [];
          const repair = repairTarget
            ? pendingPlacementRepair({
                role: upload.fqn,
                scriptName: upload.request.scriptName,
                deploymentId: (yield* readCurrentDeployment(upload.request)).id,
                baseline,
                active: versions[0]!,
                prior: yield* readVersionPlacement(
                  upload.request.accountId,
                  upload.request.scriptName,
                  repairTarget.prior,
                ),
                metadata: upload.request.metadata,
                settings: upload.previousSettings!,
                retired: retired.includes(upload.fqn),
              })
            : undefined;
          return [upload.fqn, { baseline, versions, repair }] as const;
        }).pipe(withOperation(upload.fqn, "freeze-worker-upload")),
      { concurrency: "unbounded" },
    );
    return new Map(entries);
  });

export type WorkerBaseline =
  Effect.Success<ReturnType<typeof observeWorkerBaselines>> extends ReadonlyMap<string, infer Proof>
    ? Proof
    : never;
