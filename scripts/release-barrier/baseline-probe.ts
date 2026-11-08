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

export const baselineRoles = [
  "Api",
  "AppCompiler",
  "AppData",
  "AppDomainController",
  "AppOutbound",
  "AppPages",
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

export class BaselineInventoryError extends Error {
  readonly role: (typeof baselineRoles)[number] | "(inventory)";
  readonly reason: "missing-worker" | "duplicate-worker" | "unexpected-worker";
  constructor(role: BaselineInventoryError["role"], reason: BaselineInventoryError["reason"]) {
    super(`Baseline inventory refused: ${role}; ${reason}`);
    this.role = role;
    this.reason = reason;
  }
}

export function baselineInventory(scripts: readonly { id?: string | null }[]) {
  const production = scripts.flatMap((script) =>
    typeof script.id === "string" && /^basalt-.+-production-[a-z0-9]+$/.test(script.id)
      ? [{ id: script.id }]
      : [],
  );
  const workers = baselineRoles.map((role) => {
    const matches = production.filter((script) =>
      script.id.startsWith(`basalt-${role.toLowerCase()}-production-`),
    );
    if (matches.length !== 1)
      throw new BaselineInventoryError(
        role,
        matches.length ? "duplicate-worker" : "missing-worker",
      );
    return { role, scriptName: matches[0]!.id };
  });
  if (production.length !== workers.length)
    throw new BaselineInventoryError("(inventory)", "unexpected-worker");
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
    const response = await nativeFetch(input, init);
    if (metric) {
      metric.status = response.status;
      metric.bytes += (await response.clone().arrayBuffer()).byteLength;
    }
    return response;
  };
  const program = Effect.gen(function* () {
    const inventory = yield* Workers.listScripts({ accountId });
    const workers = baselineInventory(inventory.result);
    for (const worker of workers)
      metrics.set(`${listPath}/${encodeURIComponent(worker.scriptName)}/deployments`, {
        status: null,
        bytes: 0,
        attempts: 0,
      });
    const context = yield* Effect.context<Credentials | HttpClient.HttpClient>();
    return yield* Effect.promise(() =>
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
