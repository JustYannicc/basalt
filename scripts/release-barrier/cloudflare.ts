import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { uploadResponseDiagnostic, withUploadFailure } from "./upload-failure.ts";
import { BarrierRefusal, type FrozenWorker } from "./manifest.ts";
import { uploadRequest } from "./version-request.ts";
import type { ActiveWorkerPlacement } from "./script-placement.ts";
import { readVersionPlacement } from "./active-placement-read.ts";

export const readScriptSettings = (worker: Pick<FrozenWorker, "accountId" | "scriptName">) =>
  Workers.getScriptScriptAndVersionSetting({
    accountId: worker.accountId,
    scriptName: worker.scriptName,
  }).pipe(Retry.policy(Retry.makeDefault));

export const readActivePlacements = (
  worker: Pick<FrozenWorker, "accountId" | "scriptName">,
  baseline: FrozenWorker["baseline"],
) =>
  Effect.all(
    baseline.map(({ versionId }) =>
      readVersionPlacement(worker.accountId, worker.scriptName, versionId).pipe(
        Effect.map((version): ActiveWorkerPlacement => version),
      ),
    ),
    { concurrency: "unbounded" },
  );

export const readCurrentDeployment = (worker: Pick<FrozenWorker, "accountId" | "scriptName">) =>
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
      if (!current.id) throw new BarrierRefusal("missing-live-deployment-id");
      return {
        id: current.id,
        versions: [...current.versions].sort((a, b) => a.versionId.localeCompare(b.versionId)),
      };
    }),
    // Baseline GETs are idempotent; keep the SDK's bounded transient policy local to reads.
    Retry.policy(Retry.makeDefault),
  );

export const readBaseline = (worker: Pick<FrozenWorker, "accountId" | "scriptName">) =>
  readCurrentDeployment(worker).pipe(Effect.map((current) => current.versions));

export const uploadVersion = (worker: FrozenWorker) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let diagnostic: ReturnType<typeof uploadResponseDiagnostic> | undefined;
    const observed = client.pipe(
      HttpClient.tap((response) => {
        if (response.status < 400) return Effect.void;
        diagnostic = uploadResponseDiagnostic(response.status, undefined);
        return response.json.pipe(
          Effect.match({
            onFailure: () => {},
            onSuccess: (body) => {
              diagnostic = uploadResponseDiagnostic(response.status, body);
            },
          }),
        );
      }),
    );
    return yield* Workers.createScriptVersion(uploadRequest(worker)).pipe(
      Effect.provideService(HttpClient.HttpClient, observed),
      Effect.map((result) => ({ versionId: result.id, startupTimeMs: result.startupTimeMs })),
      Retry.none,
      withUploadFailure(worker.id, () => diagnostic),
    );
  });

/** Diagnostic identity only; admission always uses the deployment's immutable serving versions. */
export const readLatestVersion = (worker: Pick<FrozenWorker, "accountId" | "scriptName">) =>
  Workers.listScriptVersions({ accountId: worker.accountId, scriptName: worker.scriptName }).pipe(
    Effect.map((response) => {
      const latest = [...(response.items ?? [])].sort(
        (a, b) => (b.number ?? -1) - (a.number ?? -1),
      )[0];
      if (!latest?.id || !/^[A-Za-z0-9_-]{1,80}$/.test(latest.id))
        throw new BarrierRefusal("latest-version-identity-unconfirmed", "PoolWorker");
      return latest.id;
    }),
    Retry.policy(Retry.makeDefault),
  );
