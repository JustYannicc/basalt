import * as Workers from "@distilled.cloud/cloudflare/workers";
import {
  Credentials,
  apiTokenCredentials,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/cloudflare/Credentials";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { brand } from "../../brand.ts";
import { baselineInventory, type BaselineProbeRow } from "./baseline-probe.ts";
import {
  candidateScriptSettings,
  candidateSettingsWithRetirements,
  type ProbeWorker,
} from "./candidate-settings.ts";
import { readActivePlacements, readCurrentDeployment, readScriptSettings } from "./cloudflare.ts";
import { readVersionPlacement } from "./active-placement-read.ts";
import {
  pendingPlacementRepair,
  placementRepairTargets,
  type PendingPlacementRepair,
} from "./pending-placement.ts";
import { BarrierRefusal } from "./manifest.ts";
import { safeProviderFailure } from "./operation-failure.ts";
import { assertScriptSettings, scriptSettingFields } from "./script-settings.ts";
import type { PropChange } from "./prop-diff.ts";

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
    const workers = baselineInventory(inventory.result);
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
    return yield* Effect.promise(() =>
      Promise.all(
        workers.map(async (worker): Promise<SettingsProbeRow> => {
          const path = `${listPath}/${encodeURIComponent(worker.scriptName)}`;
          const versionPaths: string[] = [];
          let failure: unknown;
          let compared = false;
          let repair: PendingPlacementRepair | undefined;
          const run = <A, E>(effect: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>) =>
            Effect.runPromise(effect.pipe(Effect.provideContext(context)));
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
            const versions = await run(readActivePlacements(input, baseline));
            const declaration = expected.find((item) => item.role === worker.role)!;
            const target = placementRepairTargets.find(
              (target) => target.role === worker.role && target.scriptName === worker.scriptName,
            );
            if (target && versions.some((version) => version.id === target.version)) {
              const priorPath = `${path}/versions/${target.prior}`;
              allow(priorPath);
              versionPaths.push(priorPath);
              const retired =
                declaration.retiredPlacement ??
                (
                  await (retirements ??= candidateSettingsWithRetirements(
                    workers,
                    environment,
                    nativeFetch,
                  ))
                ).find((row) => row.role === worker.role)?.retiredPlacement;
              repair = pendingPlacementRepair({
                role: worker.role,
                scriptName: worker.scriptName,
                deploymentId: baselineRead.value.id,
                baseline,
                active: versions[0]!,
                prior: await run(readVersionPlacement(accountId, worker.scriptName, target.prior)),
                metadata: declaration.metadata,
                settings,
                retired: retired === true,
              });
            } else
              assertScriptSettings(
                worker.role,
                worker.scriptName,
                expected.find((item) => item.role === worker.role)!.metadata,
                settings,
                versions,
                baseline,
              );
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
                  type: failure instanceof BarrierRefusal ? "BarrierRefusal" : provider!.type,
                  reason:
                    failure instanceof BarrierRefusal
                      ? failure.reason
                      : (provider!.reason ?? "settings-read-failed"),
                }
              : {}),
            ...metrics.get(`${path}/deployments`)!,
            settings: metrics.get(`${path}/settings`)!,
            placements,
            compared: compared || failure instanceof BarrierRefusal ? scriptSettingFields : [],
            differences: failure instanceof BarrierRefusal ? (failure.delta?.changed ?? []) : [],
            ...(repair ? { pendingPlacementRepair: repair } : {}),
          };
        }),
      ),
    );
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
