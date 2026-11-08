import { Effect } from "effect";
import type * as Workers from "@distilled.cloud/cloudflare/workers";
import { readCurrentDeployment, readScriptSettings } from "./cloudflare.ts";
import { readVersionPlacement } from "./active-placement-read.ts";
import { assertRepairBaseline, type PendingPlacementRepair } from "./pending-placement.ts";
import { BarrierRefusal, canonical, type FrozenWorker } from "./manifest.ts";

/** Latest-upload settings cannot establish which immutable version is serving traffic. */
export const verifyRepairBaseline = (
  worker: Pick<FrozenWorker, "id" | "accountId" | "scriptName" | "baseline">,
  metadata: Workers.PutScriptMetadata,
  repair: PendingPlacementRepair,
) =>
  Effect.gen(function* () {
    const deployment = yield* readCurrentDeployment(worker);
    if (
      deployment.id !== repair.deploymentId ||
      canonical(deployment.versions) !== canonical(worker.baseline)
    )
      throw new BarrierRefusal("placement-repair-deployment-drift", worker.id, {
        fqn: worker.id,
        type: "Cloudflare.Worker",
        changed: [
          {
            path: "deployment",
            old: canonical({ id: repair.deploymentId, versions: worker.baseline }),
            new: canonical(deployment),
          },
        ],
      });
    const [active, settings] = yield* Effect.all(
      [
        readVersionPlacement(worker.accountId, worker.scriptName, repair.activeVersion),
        readScriptSettings(worker),
      ],
      { concurrency: "unbounded" },
    );
    assertRepairBaseline(worker.id, worker.scriptName, metadata, settings, repair, active);
  });
