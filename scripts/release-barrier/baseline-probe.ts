import * as Workers from "@distilled.cloud/cloudflare/workers";
import {
  Credentials,
  apiTokenCredentials,
  DEFAULT_API_BASE_URL,
} from "@distilled.cloud/cloudflare/Credentials";
import { Cause, Effect, Exit } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { readBaseline } from "./cloudflare.ts";
import { safeProviderFailure } from "./operation-failure.ts";
import { digest } from "./manifest.ts";

export const baselineRoles = [
  "Api",
  "AppCompiler",
  "AppData",
  "AppDomainController",
  "AppOutbound",
  "AppPages",
  "ArtifactsCredentials",
  "Authoring",
  "Catalog",
  "Dashboard",
  "Edge",
  "Formatter",
  "InvocationTelemetry",
  "Marketing",
  "McpServer",
  "OAuthWire",
  "PoolWorker",
  "PublicSite",
  "Router",
  "Sso",
] as const;

export interface BaselineProbeRow {
  role: string;
  ok: boolean;
  type?: string;
  reason?: string;
  status: number | null;
  bytes: number;
  ms: number;
  attempts: number;
}

export interface ObservedProbeWorker {
  role: string;
  scriptName: string;
}

export class BaselineInventoryError extends Error {
  readonly refusals: readonly { role: string; reason: string }[];
  readonly workers: readonly ObservedProbeWorker[];
  constructor(
    refusals: BaselineInventoryError["refusals"],
    workers: readonly ObservedProbeWorker[] = [],
  ) {
    super(refusals.map((item) => `${item.role}: ${item.reason}`).join("; "));
    this.refusals = refusals;
    this.workers = workers;
  }
}

export function baselineInventory(
  scripts: readonly { id?: string | null; tags?: readonly string[] | null }[],
) {
  // Physical names may be truncated. These are the identities the provider writes into each script.
  const production = scripts.filter(
    (script) =>
      script.tags?.includes("alchemy:stack:basalt") &&
      script.tags.includes("alchemy:stage:production"),
  );
  const identities = production.map((script) => ({
    script,
    ids: script.tags!.filter((tag) => tag.startsWith("alchemy:id:")),
  }));
  const refusals: { role: string; reason: string }[] = [];
  const workers = baselineRoles.flatMap((role) => {
    const matches = identities.filter(({ ids }) => ids.includes(`alchemy:id:${role}`));
    if (matches.length !== 1) {
      refusals.push({
        role,
        reason: `${matches.length ? "duplicate-worker" : "missing-worker"}; expected 1, observed ${matches.length}`,
      });
      return [];
    }
    const { script, ids } = matches[0]!;
    if (
      ids.length !== 1 ||
      script.tags!.filter((tag) => tag.startsWith("alchemy:stack:")).length !== 1 ||
      script.tags!.filter((tag) => tag.startsWith("alchemy:stage:")).length !== 1 ||
      typeof script.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(script.id)
    ) {
      refusals.push({
        role,
        reason: `invalid-worker-identity; logical-id tags expected 1, observed ${ids.length}; stack tags expected 1, observed ${script.tags!.filter((tag) => tag.startsWith("alchemy:stack:")).length}; stage tags expected 1, observed ${script.tags!.filter((tag) => tag.startsWith("alchemy:stage:")).length}; valid script ID expected true, observed ${typeof script.id === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(script.id)}`,
      });
      return [];
    }
    return [{ role, scriptName: script.id }];
  });
  for (const { script, ids } of identities.filter(
    ({ ids }) => !ids.some((id) => baselineRoles.some((role) => id === `alchemy:id:${role}`)),
  ))
    refusals.push({
      role: "(inventory)",
      reason: `unexpected-worker; expected 0, observed 1; target sha256:${digest(JSON.stringify([script.id, ids]))}`,
    });
  if (refusals.length) throw new BaselineInventoryError(refusals, workers);
  return workers;
}

/** Shares the release's native fetch transport, concurrent Promise boundary and per-read retry policy. */
export async function probeBaselines(
  accountId: string,
  apiToken: string,
  apiBaseUrl = DEFAULT_API_BASE_URL,
) {
  const base = new URL(apiBaseUrl);
  const listPath = `${base.pathname.replace(/\/$/, "")}/accounts/${encodeURIComponent(accountId)}/workers/scripts`;
  const metrics = new Map<string, { status: number | null; bytes: number; attempts: number }>();
  const nativeFetch = globalThis.fetch;
  const measuredFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const metric = metrics.get(url.pathname);
    if (
      url.origin !== base.origin ||
      method !== "GET" ||
      (url.pathname !== listPath && !metric) ||
      url.search ||
      init?.body != null ||
      (input instanceof Request && input.body !== null)
    )
      throw new Error("Baseline probe refused a request outside its read-only inventory");
    if (metric) metric.attempts++;
    const response = await nativeFetch(input, { ...init, redirect: "error" });
    if (metric) {
      metric.status = response.status;
      metric.bytes += (await response.clone().arrayBuffer()).byteLength;
    }
    return response;
  };
  const program = Effect.gen(function* () {
    const inventory = yield* Workers.listScripts({ accountId });
    let workers;
    let refusals: BaselineInventoryError["refusals"] = [];
    try {
      workers = baselineInventory(inventory.result);
    } catch (error) {
      if (!(error instanceof BaselineInventoryError)) throw error;
      workers = error.workers;
      refusals = error.refusals;
    }
    for (const worker of workers)
      metrics.set(`${listPath}/${encodeURIComponent(worker.scriptName)}/deployments`, {
        status: null,
        bytes: 0,
        attempts: 0,
      });
    const context = yield* Effect.context<Credentials | HttpClient.HttpClient>();
    const rows = yield* Effect.promise(() =>
      Promise.all(
        workers.map(async (worker): Promise<BaselineProbeRow> => {
          const start = performance.now();
          // Retain the caller's excess-property shape without reading production bindings or module bytes.
          const input = {
            accountId,
            scriptName: worker.scriptName,
            id: worker.role,
            metadata: {},
            files: [],
          };
          const result = await Effect.runPromiseExit(
            readBaseline(input).pipe(Effect.provideContext(context)),
          );
          const failure = Exit.isFailure(result)
            ? safeProviderFailure(Cause.squash(result.cause))
            : undefined;
          const metric = metrics.get(
            `${listPath}/${encodeURIComponent(worker.scriptName)}/deployments`,
          )!;
          return {
            role: worker.role,
            ok: Exit.isSuccess(result),
            ...(failure
              ? { type: failure.type, ...(failure.reason ? { reason: failure.reason } : {}) }
              : {}),
            ...metric,
            ms: Math.round(performance.now() - start),
          };
        }),
      ),
    );
    return [
      ...rows,
      ...refusals.map((refusal): BaselineProbeRow => ({
        ...refusal,
        ok: false,
        type: "BaselineInventoryError",
        status: null,
        bytes: 0,
        ms: 0,
        attempts: 0,
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

export function baselineProbeTable(rows: readonly BaselineProbeRow[]) {
  return [
    "| Worker | Result | Type | Reason | HTTP | Response bytes | Duration ms | Attempts |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
    ...rows.map(
      (row) =>
        `| ${row.role} | ${row.ok ? "PASS" : "FAIL"} | ${row.type ?? ""} | ${row.reason ?? ""} | ${row.status ?? ""} | ${row.bytes} | ${row.ms} | ${row.attempts} |`,
    ),
  ].join("\n");
}
