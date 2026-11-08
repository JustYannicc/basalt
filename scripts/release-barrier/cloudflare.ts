import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect } from "effect";
import { BarrierRefusal, type FrozenWorker } from "./manifest.ts";
import { uploadRequest } from "./version-request.ts";

export const readBaseline = (worker: Pick<FrozenWorker, "accountId" | "scriptName">) =>
  // The SDK serializes excess properties as a body, including on GET. Callers pass upload and frozen objects.
  Workers.listScriptDeployments({
    accountId: worker.accountId,
    scriptName: worker.scriptName,
  }).pipe(
    Effect.map((response) => {
      const deployments = response.deployments;
      if (
        !deployments.length ||
        deployments.some((item) => !Number.isFinite(Date.parse(item.createdOn)))
      )
        throw new BarrierRefusal("missing-live-deployment");
      const current = [...deployments].sort(
        (a, b) => Date.parse(b.createdOn) - Date.parse(a.createdOn),
      )[0]!;
      return [...current.versions].sort((a, b) => a.versionId.localeCompare(b.versionId));
    }),
    // Baseline GETs are idempotent; keep the SDK's bounded transient policy local to reads.
    Retry.policy(Retry.makeDefault),
  );

export const uploadVersion = (worker: FrozenWorker) =>
  Workers.createScriptVersion(uploadRequest(worker)).pipe(
    Effect.map((result) => ({ versionId: result.id, startupTimeMs: result.startupTimeMs })),
    Retry.none,
  );
