import { freezeUpload } from "./version-request.ts";
import { assertBaselineWorkerInput } from "./container.ts";
import { safeInputHash, servingWorkerSettings, workerInputHash } from "./serving-worker-input.ts";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import {
  Credentials,
  apiTokenCredentials,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/cloudflare/Credentials";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { brand } from "../../brand.ts";
import {
  BaselineInventoryError,
  baselineInventory,
  type BaselineProbeRow,
} from "./baseline-probe.ts";
import {
  candidateScriptSettings,
  candidateSettingsWithRetirements,
  type ProbeWorker,
} from "./candidate-settings.ts";
import {
  readActivePlacements,
  readCurrentDeployment,
  readScriptSettings,
  readLatestVersion,
} from "./cloudflare.ts";
import { readVersionPlacement } from "./active-placement-read.ts";
import {
  pendingPlacementRepair,
  placementRepairTargets,
  type PendingPlacementRepair,
} from "./pending-placement.ts";
import { BarrierRefusal } from "./manifest.ts";
import { safeProviderFailure } from "./operation-failure.ts";
import { scriptSettingFields } from "./script-settings.ts";
import type { PropChange } from "./prop-diff.ts";
import { verifyRepairBaseline } from "./repair-baseline.ts";
import { CandidateSettingsReadFailure } from "./candidate-failure.ts";

interface ReadMetrics {
  status: number | null;
  bytes: number;
  ms: number;
  attempts: number;
}
export interface SettingsProbeRow extends BaselineProbeRow {
  settings: ReadMetrics;
  placements: ReadMetrics;
  compared: readonly string[];
  differences: readonly PropChange[];
  pendingPlacementRepair?: PendingPlacementRepair;
  preparation?: {
    frozen: true;
    containerInput?: {
      baseline: string;
      settings: string;
      serving: string;
      versions: string[];
      latestVersion: string;
      latestInput: string;
      settingsMatchLatest: boolean;
    };
  };
}
type CandidateReader = (workers: readonly ProbeWorker[]) => Promise<
  readonly {
    role: string;
    scriptName: string;
    metadata: Workers.PutScriptMetadata;
    retiredPlacement?: boolean;
  }[]
>;
const empty = (): ReadMetrics => ({ status: null, bytes: 0, ms: 0, attempts: 0 });

/** No module/content reads, writes, redirects, queries or latest-version inheritance are allowed. */
export async function probeWorkerSettings(
  accountId: string,
  apiToken: string,
  environment: NodeJS.ProcessEnv,
  apiBaseUrl = DEFAULT_API_BASE_URL,
  candidate?: CandidateReader,
  retirementReader = candidateSettingsWithRetirements,
  containerBaselineInputHash?: string,
) {
  const base = new URL(apiBaseUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  const listPath = `${prefix}/accounts/${encodeURIComponent(accountId)}/workers/scripts`;
  const metrics = new Map<string, ReadMetrics>();
  const allow = (path: string) => {
    if (!metrics.has(path)) metrics.set(path, empty());
  };
  const nativeFetch = globalThis.fetch;
  const measuredFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const zones =
      url.pathname === `${prefix}/zones` &&
      [...url.searchParams].length === 3 &&
      url.searchParams.getAll("account.id").length === 1 &&
      url.searchParams.get("account.id") === accountId &&
      url.searchParams.getAll("name").length === 1 &&
      url.searchParams.get("name") === brand.zone &&
      url.searchParams.getAll("per_page").length === 1 &&
      url.searchParams.get("per_page") === "1";
    const namespaces =
      url.pathname ===
        `${prefix}/accounts/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces` &&
      [...url.searchParams].length === 1 &&
      url.searchParams.getAll("page").length === 1 &&
      /^[1-9][0-9]*$/.test(url.searchParams.get("page") ?? "");
    if (
      url.origin !== base.origin ||
      method !== "GET" ||
      (!zones &&
        !namespaces &&
        (url.search || (url.pathname !== listPath && !metrics.has(url.pathname)))) ||
      init?.body != null ||
      (input instanceof Request && input.body !== null)
    )
      throw new Error("Settings probe refused a request outside its read-only inventory");
    const metric = metrics.get(url.pathname);
    if (metric) metric.attempts++;
    const start = performance.now();
    try {
      const response = await nativeFetch(input, { ...init, redirect: "error" });
      if (metric) {
        metric.status = response.status;
        metric.bytes += (await response.clone().arrayBuffer()).byteLength;
      }
      return response;
    } finally {
      if (metric) metric.ms += Math.round(performance.now() - start);
    }
  };
  const program = Effect.gen(function* () {
    const inventory = yield* Workers.listScripts({ accountId });
    let workers;
    let inventoryRefusals: BaselineInventoryError["refusals"] = [];
    try {
      workers = baselineInventory(inventory.result);
    } catch (error) {
      if (!(error instanceof BaselineInventoryError)) throw error;
      workers = error.workers;
      inventoryRefusals = error.refusals;
    }
    for (const worker of workers) {
      const path = `${listPath}/${encodeURIComponent(worker.scriptName)}`;
      allow(`${path}/deployments`);
      allow(`${path}/settings`);
    }
    // Declaration imports use this same deny-by-default transport before any source is evaluated.
    const expected = yield* Effect.tryPromise({
      try: async () => {
        globalThis.fetch = measuredFetch;
        try {
          return await (candidate
            ? candidate(workers)
            : candidateScriptSettings(workers, environment));
        } finally {
          globalThis.fetch = nativeFetch;
        }
      },
      catch: (error) => error,
    });
    if (
      expected.length !== workers.length ||
      new Set(expected.map((item) => item.role)).size !== workers.length ||
      workers.some(
        (worker) =>
          !expected.some(
            (item) => item.role === worker.role && item.scriptName === worker.scriptName,
          ),
      )
    )
      throw new BarrierRefusal("candidate-worker-coverage");
    let retirements: ReturnType<typeof candidateSettingsWithRetirements> | undefined;
    const context = yield* Effect.context<Credentials | HttpClient.HttpClient>();
    const rows = yield* Effect.promise(() =>
      Promise.all(
        workers.map(async (worker): Promise<SettingsProbeRow> => {
          const path = `${listPath}/${encodeURIComponent(worker.scriptName)}`;
          const versionPaths: string[] = [];
          let failure: unknown;
          let compared = false;
          let preparation: SettingsProbeRow["preparation"];
          let repair: PendingPlacementRepair | undefined;
          let readStage = "settings";
          const run = async <A, E>(
            effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
          ) => {
            const exit = await Effect.runPromiseExit(effect.pipe(Effect.provideContext(context)));
            if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
            return exit.value;
          };
          try {
            const input = {
              accountId,
              scriptName: worker.scriptName,
              id: worker.role,
              metadata: {},
              files: [],
            };
            const reads = await Promise.allSettled([
              run(readCurrentDeployment(input)),
              run(readScriptSettings(input)),
            ]);
            const [baselineRead, settingsRead] = reads;
            if (baselineRead.status === "rejected") throw baselineRead.reason;
            if (settingsRead.status === "rejected") throw settingsRead.reason;
            const baseline = baselineRead.value.versions;
            const settings = settingsRead.value;
            for (const { versionId } of baseline) {
              if (!/^[A-Za-z0-9_-]{1,80}$/.test(versionId))
                throw new BarrierRefusal("active-version-identity-drift", worker.role);
              const versionPath = `${path}/versions/${encodeURIComponent(versionId)}`;
              allow(versionPath);
              versionPaths.push(versionPath);
            }
            readStage = "serving-version";
            const versions = await run(readActivePlacements(input, baseline));
            const declaration = expected.find((item) => item.role === worker.role)!;
            const target = placementRepairTargets.find(
              (target) => target.role === worker.role && target.scriptName === worker.scriptName,
            );
            if (target && versions.some((version) => version.id === target.version)) {
              const priorPath = `${path}/versions/${target.prior}`;
              allow(priorPath);
              versionPaths.push(priorPath);
              readStage = "retirement";
              const retired =
                declaration.retiredPlacement ??
                (await (retirements ??= retirementReader(workers, environment, nativeFetch))).find(
                  (row) => row.role === worker.role,
                )?.retiredPlacement;
              readStage = "prior-version";
              const prior = await run(
                readVersionPlacement(accountId, worker.scriptName, target.prior),
              );
              readStage = "classification";
              repair = pendingPlacementRepair({
                role: worker.role,
                scriptName: worker.scriptName,
                deploymentId: baselineRead.value.id,
                baseline,
                active: versions[0]!,
                prior,
                metadata: declaration.metadata,
                settings,
                retired: retired === true,
              });
              readStage = "pre-activation-baseline";
              await run(verifyRepairBaseline({ ...input, baseline }, declaration.metadata, repair));
            }
            readStage = "freeze-worker-upload";
            const frozen = await freezeUpload(
              {
                fqn: worker.role,
                request: { ...input, metadata: declaration.metadata },
                previousSettings: settings,
                previousProps: {},
                props: {},
              },
              baseline,
              versions,
              repair,
            );
            preparation = { frozen: true };
            if (worker.role === "PoolWorker" && containerBaselineInputHash !== undefined) {
              const serving = servingWorkerSettings(versions, baseline);
              allow(`${path}/versions`);
              const latestVersion = await run(readLatestVersion(input));
              const latestPath = `${path}/versions/${encodeURIComponent(latestVersion)}`;
              allow(latestPath);
              versionPaths.push(latestPath);
              const latest = await run(
                readVersionPlacement(accountId, worker.scriptName, latestVersion),
              );
              preparation.containerInput = {
                baseline: safeInputHash(containerBaselineInputHash),
                settings: safeInputHash(workerInputHash(settings)),
                serving: safeInputHash(frozen.baselineImageHash),
                versions: baseline.map(({ versionId }) => versionId.slice(0, 12)),
                latestVersion: latestVersion.slice(0, 12),
                latestInput: safeInputHash(workerInputHash(latest)),
                settingsMatchLatest: workerInputHash(settings) === workerInputHash(latest),
              };
              readStage = "container-baseline-worker-input";
              assertBaselineWorkerInput({ baselineInputHash: containerBaselineInputHash }, serving);
            }
            compared = true;
          } catch (error) {
            failure = error;
          }
          const provider = failure ? safeProviderFailure(failure) : undefined;
          const placements = versionPaths.reduce((total, key) => {
            const value = metrics.get(key)!;
            return {
              status: value.status,
              bytes: total.bytes + value.bytes,
              ms: total.ms + value.ms,
              attempts: total.attempts + value.attempts,
            };
          }, empty());
          return {
            role: worker.role,
            ok: compared,
            ...(failure
              ? {
                  type:
                    failure instanceof CandidateSettingsReadFailure
                      ? failure._tag
                      : failure instanceof BarrierRefusal
                        ? "BarrierRefusal"
                        : provider!.type,
                  reason:
                    failure instanceof CandidateSettingsReadFailure
                      ? `${readStage}: ${failure.message}`
                      : failure instanceof BarrierRefusal
                        ? failure.reason
                        : (provider!.reason ?? `${readStage}-read-failed`),
                }
              : {}),
            ...metrics.get(`${path}/deployments`)!,
            settings: metrics.get(`${path}/settings`)!,
            placements,
            compared: compared || failure instanceof BarrierRefusal ? scriptSettingFields : [],
            differences: failure instanceof BarrierRefusal ? (failure.delta?.changed ?? []) : [],
            ...(repair ? { pendingPlacementRepair: repair } : {}),
            ...(preparation ? { preparation } : {}),
          };
        }),
      ),
    );
    return [
      ...rows,
      ...inventoryRefusals.map((refusal): SettingsProbeRow => ({
        ...refusal,
        ok: false,
        type: "BaselineInventoryError",
        ...empty(),
        settings: empty(),
        placements: empty(),
        compared: [],
        differences: [],
      })),
    ].sort((a, b) => a.role.localeCompare(b.role));
  });
  const result = await Effect.runPromiseExit(
    program.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, measuredFetch),
      Effect.provideService(
        Credentials,
        Effect.succeed(apiTokenCredentials({ apiToken, apiBaseUrl })),
      ),
    ),
  );
  if (Exit.isFailure(result)) throw Cause.squash(result.cause);
  return result.value;
}
