import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect } from "effect";
import { readCurrentDeployment } from "./cloudflare.ts";
import { assertFirstHandoffEnable, type FirstHandoffManifest } from "./first-handoff-contract.ts";
import type { ProvisioningEnable } from "./provisioning-contract.ts";
import {
  handoffWorkerRefusal,
  sameHandoffWorkerValue,
  type FirstHandoffWorker,
} from "./first-handoff-worker.ts";
import { withOperation } from "./operation-failure.ts";

/** The first-handoff service is the only caller; ordinary release activation does not construct it. */
export const firstHandoffWorkerProvider = (
  manifest: FirstHandoffManifest,
  enable: ProvisioningEnable | undefined,
  now = Date.now,
) =>
  Effect.gen(function* () {
    const context =
      yield* Effect.context<Effect.Services<ReturnType<typeof Workers.getBetaWorkerVersion>>>();
    const run = Effect.runPromiseWith(context);
    const target = {
      accountId: manifest.baseline.accountId,
      scriptName: manifest.baseline.scriptName,
    };
    const version = (versionId: string) =>
      run(
        Workers.getBetaWorkerVersion({
          accountId: target.accountId,
          workerId: target.scriptName,
          versionId,
          include: "modules",
        }).pipe(Retry.none, withOperation("PoolWorker", "read-worker-baseline")),
      );
    const provider: FirstHandoffWorker = {
      version,
      observe: async () => {
        const current = await run(
          readCurrentDeployment(target).pipe(withOperation("PoolWorker", "read-worker-baseline")),
        );
        if (current.versions.length !== 1 || current.versions[0]!.percentage !== 100)
          throw handoffWorkerRefusal(
            "first-handoff-split-Worker",
            "firstHandoff.Worker.deployment",
            "one-version-at-100-percent",
            current.versions,
          );
        return {
          ...target,
          deploymentId: current.id,
          version: await version(current.versions[0]!.versionId),
        };
      },
      stage: async (request) => {
        assertFirstHandoffEnable(manifest, enable, now());
        sameHandoffWorkerValue(
          "firstHandoff.Worker.destination",
          { accountId: target.accountId, workerId: target.scriptName, deploy: false },
          { accountId: request.accountId, workerId: request.workerId, deploy: request.deploy },
        );
        const result = await run(Workers.createBetaWorkerVersion(request).pipe(Retry.none));
        if (
          !Number.isFinite(result.startupTimeMs) ||
          result.startupTimeMs! < 0 ||
          result.startupTimeMs! > 750
        )
          throw handoffWorkerRefusal(
            "first-handoff-startup-unverified",
            "firstHandoff.Worker.startupTimeMs",
            "0..750",
            result.startupTimeMs ?? null,
          );
        return { versionId: result.id, startupTimeMs: result.startupTimeMs! };
      },
      activate: async (versionId) => {
        assertFirstHandoffEnable(manifest, enable, now());
        const result = await run(
          Workers.createScriptDeployment({
            ...target,
            strategy: "percentage",
            versions: [{ versionId, percentage: 100 }],
            annotations: { workersMessage: `first-handoff:${manifest.legacy.operationId}` },
          }).pipe(Retry.none),
        );
        sameHandoffWorkerValue(
          "firstHandoff.Worker.activation",
          [{ versionId, percentage: 100 }],
          result.versions,
        );
        return { deploymentId: result.id };
      },
    };
    return provider;
  });
