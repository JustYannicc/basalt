import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect } from "effect";
import { BarrierRefusal, type FrozenWorker } from "./manifest.ts";
import { uploadRequest } from "./version-request.ts";

export const readBaseline = (worker: Pick<FrozenWorker, "accountId" | "scriptName">) =>
  Workers.listScriptDeployments(worker).pipe(
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
    Retry.none,
  );

export const uploadVersion = (worker: FrozenWorker) =>
  Workers.createScriptVersion(uploadRequest(worker)).pipe(
    Effect.map((result) => ({ versionId: result.id, startupTimeMs: result.startupTimeMs })),
    Retry.none,
  );
