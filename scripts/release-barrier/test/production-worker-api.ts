/**
 * A GET-only Cloudflare stand-in serving PoolWorker as production serves it; every response comes
 * from production-pool-worker-shape.ts. Any non-GET request fails the test, so a reader that writes
 * cannot pass.
 */
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import {
  cloudflareResult,
  productionDeploymentsBody,
  productionNamespaceResponse,
  productionNamespaceRow,
  productionProfileBody,
  productionScriptVersionBody,
  productionSdkLayer,
  productionSettingsBody,
  productionTags,
  productionVersionBody,
} from "./production-pool-worker-shape.ts";

export interface ProductionWorker {
  accountId: string;
  scriptName: string;
  versionId: string;
  /** Local classes the deploy created, with their namespace ids; PoolContainer is container-backed. */
  classes: Readonly<Record<string, string>>;
  /** Classes the script links to a container. */
  containers: readonly string[];
  /** Production's PoolWorker has none; set only to model a tagged Worker. */
  migrationTag?: string;
}

export const productionWorker = (classes: Readonly<Record<string, string>> = {}) =>
  ({
    accountId: "1".repeat(32),
    scriptName: "synthetic-worker",
    versionId: "production-version",
    classes: { PoolContainer: "legacy-namespace", ...classes },
    containers: ["PoolContainer"],
  }) satisfies ProductionWorker;

const foreign = {
  type: "durable_object_namespace",
  name: "BulkUsageImport",
  class_name: "ArtifactsTokenCoordinator",
  script_name: "synthetic-other-worker",
  namespace_id: "foreign-namespace",
};
const bindingsOf = (worker: ProductionWorker) => [
  ...Object.entries(worker.classes).map(([className, namespaceId]) => ({
    type: "durable_object_namespace",
    name: className,
    class_name: className,
    namespace_id: namespaceId,
  })),
  // A cross-script reference: never a local class.
  foreign,
];

/** Cloudflare returns module bodies only for include=modules; without it the key is absent. */
export const productionVersion = (worker: ProductionWorker, modules = true) => {
  const body = productionVersionBody({
    id: worker.versionId,
    mainModule: "worker.js",
    modules: [
      {
        name: "worker.js",
        content_type: "application/javascript+module",
        content_base64: Buffer.from("export default {};\n").toString("base64"),
      },
    ],
    bindings: bindingsOf(worker),
    containers: worker.containers,
  });
  if (modules) return body;
  const { modules: _bodies, ...version } = body;
  return version;
};

/** The production GETs a namespace and class reader makes; undefined for any other route. */
export function productionWorkerResponse(
  worker: ProductionWorker,
  method: string,
  url: URL,
): Response | undefined {
  const base = `/client/v4/accounts/${worker.accountId}/workers`;
  const routes: Record<string, () => Response> = {
    [`${base}/scripts/${worker.scriptName}/deployments`]: () =>
      cloudflareResult(productionDeploymentsBody(worker.versionId)),
    [`${base}/workers/${worker.scriptName}/versions/${worker.versionId}`]: () =>
      cloudflareResult(productionVersion(worker, url.searchParams.get("include") === "modules")),
    [`${base}/durable_objects/namespaces`]: () =>
      productionNamespaceResponse(url, [
        ...Object.entries(worker.classes).map(([className, id]) =>
          productionNamespaceRow(worker.scriptName, className, id),
        ),
        productionNamespaceRow(
          "synthetic-other-worker",
          "ArtifactsTokenCoordinator",
          "foreign-namespace",
        ),
      ]),
    [`${base}/scripts/${worker.scriptName}/settings`]: () =>
      cloudflareResult(
        productionSettingsBody(
          bindingsOf(worker),
          productionTags(Object.keys(worker.classes), worker.migrationTag),
        ),
      ),
    [`${base}/scripts/${worker.scriptName}/versions/${worker.versionId}`]: () =>
      cloudflareResult(
        productionScriptVersionBody({
          id: worker.versionId,
          bindings: bindingsOf(worker),
          classes: Object.keys(worker.classes),
          migrationTag: worker.migrationTag,
        }),
      ),
    [`${base}/workers/${worker.scriptName}`]: () =>
      cloudflareResult(productionProfileBody(worker.scriptName, `${worker.scriptName}-identity`)),
  };
  const route = routes[url.pathname];
  if (!route) return undefined;
  if (method !== "GET") throw new Error(`production stand-in refuses ${method} ${url.pathname}`);
  return route();
}

/** The SDK services a reader needs, answering only the production GETs. */
export function productionWorkerApi(worker: ProductionWorker) {
  const counts = { reads: 0, writes: 0 };
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      if (request.method !== "GET") counts.writes++;
      const response = productionWorkerResponse(worker, request.method, url);
      if (!response) throw new Error(`production stand-in has no route for ${url.pathname}`);
      counts.reads++;
      return HttpResponse.fromWeb(request, response);
    }),
  );
  return { counts, layer: productionSdkLayer(client) };
}
