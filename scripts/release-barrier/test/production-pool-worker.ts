/**
 * A stateful, production-shaped PoolWorker for the release proof: an alchemy, migrations-based
 * Worker with no migration tag, PoolContainer as its only container class, and the account's DO
 * namespaces. It answers the reviewed class path's own SDK and fetch calls (read, content, the
 * additive script PUT and the inactive clone) and the bootstrap's namespace read, and it refuses
 * what Cloudflare refuses: a migration tag on an untagged script, re-creating an existing class, a
 * module that does not parse, or an upload that copies Cloudflare's own triggered_by annotation.
 * An upload that omits container links drops them, as a full-script PUT would. Every version and
 * settings read-back is built by production-pool-worker-shape.ts, the same source as the GET-only
 * stand-in; the inactive clone's read-back echoes the posted body.
 */
import { Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import {
  cloudflareFailure,
  cloudflareResult,
  productionDeploymentsBody,
  productionNamespaceResponse,
  productionModuleRefusal,
  productionNamespaceRow,
  productionProfileBody,
  productionScriptVersionBody,
  productionSdkLayer,
  productionSettingsBody,
  providerTriggeredBy,
  productionTags,
  productionVersionBody,
} from "./production-pool-worker-shape.ts";

type Binding = Record<string, unknown> & { type: string; name: string };
interface Version {
  id: string;
  bindings: Binding[];
  containers: string[];
  files: { name: string; type: string; bytes: Uint8Array }[];
  mainModule: string;
  annotations?: Record<string, string>;
}

export function productionPoolWorker(input: { accountId: string; scriptName: string }) {
  const { accountId, scriptName } = input;
  const classes: Record<string, string> = { PoolContainer: "legacy-namespace" };
  const tags = productionTags(Object.keys(classes));
  let serial = 0;
  const versions = new Map<string, Version>();
  // Inactive clones are ordinary versions that no deployment serves.
  const clones = new Set<string>();
  const doBinding = (name: string): Binding => ({
    type: "durable_object_namespace",
    name,
    class_name: name,
    namespace_id: classes[name]!,
  });
  let active = "production-version";
  // `latest` is the most recent upload, deployed or not, as Cloudflare resolves it.
  let latest = active;
  versions.set(active, {
    id: active,
    bindings: [
      doBinding("PoolContainer"),
      { type: "plain_text", name: "POOL_PRESERVE_LEGACY_IMAGE", text: "true" },
    ],
    containers: ["PoolContainer"],
    files: [
      {
        name: "worker.js",
        type: "application/javascript+module",
        bytes: new TextEncoder().encode("export class PoolContainer {}\nexport default {};\n"),
      },
      // Production's content read returns the entry and its source map as two parts.
      {
        name: "worker.js.map",
        type: "application/source-map",
        bytes: new TextEncoder().encode('{"version":3,"sources":[],"mappings":""}'),
      },
    ],
    mainModule: "worker.js",
  });
  const log = { puts: [] as Record<string, unknown>[], refusals: [] as string[], writes: 0 };
  const current = () => versions.get(active)!;
  const deploy = (version: Version) => {
    versions.set(version.id, version);
    active = version.id;
    latest = version.id;
  };
  const failure = cloudflareFailure;
  // Cloudflare's code for an absent Worker version; the SDK maps it to WorkerVersionNotFound.
  const versionMissing = () => failure("version not found", 404, 10071);
  const ok = cloudflareResult;
  // Production's /settings follows the latest upload, deployed or not, not the serving version.
  const settings = () => {
    const version = versions.get(latest)!;
    return productionSettingsBody(version.bindings, tags, version.annotations);
  };

  async function respond(method: string, url: URL, body: () => Promise<unknown>) {
    const base = `/client/v4/accounts/${accountId}/workers`;
    const path = url.pathname;
    if (method === "GET") {
      if (path === `${base}/scripts/${scriptName}/deployments`)
        return ok(productionDeploymentsBody(active));
      if (path === `${base}/scripts/${scriptName}/settings`) return ok(settings());
      // The profile id is the Worker's native id, which the release's state row records.
      if (path === `${base}/workers/${scriptName}`)
        return ok(productionProfileBody(scriptName, scriptName));
      if (path === `${base}/durable_objects/namespaces`)
        return productionNamespaceResponse(
          url,
          Object.entries(classes).map(([name, id]) => productionNamespaceRow(scriptName, name, id)),
        );
      const classic = new RegExp(`^${base}/scripts/${scriptName}/versions/([^/]+)$`, "u").exec(
        path,
      );
      if (classic) {
        const version = versions.get(classic[1]!);
        if (!version) return versionMissing();
        // No migration tag: alchemy created this Worker untagged and never bumps an absent tag.
        return ok(
          productionScriptVersionBody({
            id: version.id,
            bindings: version.bindings,
            classes: Object.keys(classes),
          }),
        );
      }
      const beta = new RegExp(`^${base}/workers/${scriptName}/versions/([^/]+)$`, "u").exec(path);
      if (beta) {
        const id = beta[1] === "latest" ? latest : beta[1]!;
        const version = versions.get(id);
        if (!version) return versionMissing();
        return ok(
          productionVersionBody({
            id: version.id,
            mainModule: version.mainModule,
            // The module read-back lists code modules only, never the source map.
            modules: version.files
              .filter((file) => file.type !== "application/source-map")
              .map((file) => ({
                name: file.name,
                content_type: file.type,
                content_base64: Buffer.from(file.bytes).toString("base64"),
              })),
            bindings: version.bindings,
            containers: version.containers,
            annotations: version.annotations,
          }),
        );
      }
      if (path === `${base}/scripts/${scriptName}/content/v2`) {
        const version = versions.get(url.searchParams.get("version") ?? "");
        if (!version) return failure("version not found", 404);
        const form = new FormData();
        for (const file of version.files)
          form.set(
            file.name,
            new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
          );
        return new Response(form, { headers: { "cf-entrypoint": version.mainModule } });
      }
      return undefined;
    }
    log.writes++;
    if (method === "PUT" && path === `${base}/scripts/${scriptName}`) {
      const form = (await body()) as FormData;
      const part = form.get("metadata");
      const metadata = JSON.parse(
        typeof part === "string" ? part : await (part as Blob).text(),
      ) as Record<string, unknown> & {
        bindings: Binding[];
        migrations?: Record<string, unknown>;
        containers?: { class_name: string }[];
        tags: string[];
        annotations?: Record<string, string>;
        main_module: string;
      };
      log.puts.push(metadata);
      // Cloudflare refused an upload that copied its own annotation (State Worker, 2026-11-08).
      if (metadata.annotations?.[providerTriggeredBy] !== undefined) {
        log.refusals.push("provider-managed-annotation");
        return failure("annotations: workers/triggered_by is read-only");
      }
      const files = await Promise.all(
        [...form.entries()]
          .filter(([name]) => name !== "metadata")
          .map(async ([, item]) => {
            const file = item as File;
            return {
              name: file.name,
              type: file.type,
              bytes: new Uint8Array(await file.arrayBuffer()),
            };
          }),
      );
      const unparsed = await productionModuleRefusal(files);
      if (unparsed) {
        log.refusals.push("module-syntax-error");
        return unparsed;
      }
      const migration = metadata.migrations ?? {};
      if (migration.old_tag || migration.new_tag) {
        log.refusals.push("migration-tag-on-untagged-script");
        return failure("Migration tag precondition failed: the script has no migration tag");
      }
      const created = (migration.new_sqlite_classes as string[] | undefined) ?? [];
      if (created.some((name) => classes[name])) {
        log.refusals.push("class-already-exists");
        return failure("Cannot create a Durable Object class that already exists");
      }
      for (const name of created) classes[name] = `${name.toLowerCase()}-namespace`;
      const previous = current();
      const bindings = metadata.bindings.map((binding) =>
        binding.type === "inherit"
          ? previous.bindings.find((item) => item.name === binding.name)!
          : binding.type === "durable_object_namespace"
            ? doBinding(String(binding.class_name))
            : binding,
      );
      deploy({
        id: `expanded-${++serial}`,
        bindings,
        containers: (metadata.containers ?? []).map((container) => container.class_name),
        files,
        mainModule: metadata.main_module,
        annotations: { ...metadata.annotations, [providerTriggeredBy]: "upload" },
      });
      tags.splice(0, tags.length, ...metadata.tags);
      return ok({ id: scriptName, tag: scriptName, startup_time_ms: 100 });
    }
    if (method === "POST" && path === `${base}/workers/${scriptName}/versions`) {
      const clone = (await body()) as Record<string, unknown> & {
        annotations?: Record<string, string>;
      };
      if (clone.annotations?.[providerTriggeredBy] !== undefined) {
        log.refusals.push("provider-managed-annotation");
        return failure("annotations: workers/triggered_by is read-only");
      }
      const files = (
        (clone.modules ?? []) as { name: string; content_type: string; content_base64: string }[]
      ).map((module) => ({
        name: module.name,
        type: module.content_type,
        bytes: new Uint8Array(Buffer.from(module.content_base64, "base64")),
      }));
      const unparsed = await productionModuleRefusal(files);
      if (unparsed) {
        log.refusals.push("module-syntax-error");
        return unparsed;
      }
      const id = `clone-${++serial}`;
      latest = id;
      clones.add(id);
      versions.set(id, {
        id,
        bindings: current().bindings,
        containers: ((clone.containers ?? []) as { class_name: string }[]).map(
          (container) => container.class_name,
        ),
        files,
        mainModule: String(clone.main_module),
        annotations: { ...clone.annotations, [providerTriggeredBy]: "version_upload" },
      });
      return ok({ id, number: 1, created_on: "2026-11-17T00:00:00Z", urls: [] });
    }
    const removed = new RegExp(`^${base}/workers/${scriptName}/versions/([^/]+)$`, "u").exec(path);
    if (method === "DELETE" && removed && clones.delete(removed[1]!)) {
      versions.delete(removed[1]!);
      if (latest === removed[1]) latest = active;
      return ok(null);
    }
    return undefined;
  }

  const client = HttpClient.make((request, url) =>
    Effect.promise(async () => {
      const response = await respond(request.method, url, async () =>
        request.body._tag === "FormData"
          ? request.body.formData
          : request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
      );
      if (!response)
        throw new Error(`production PoolWorker has no route for ${request.method} ${url.pathname}`);
      return HttpResponse.fromWeb(request, response);
    }),
  );
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const response = await respond(init?.method ?? "GET", url, async () => undefined);
    if (!response) throw new Error(`production PoolWorker has no route for ${url.pathname}`);
    return response;
  };
  const layer = productionSdkLayer(client, { CLOUDFLARE_API_TOKEN: "synthetic-never-sent" });
  return {
    layer,
    fetcher,
    log,
    classes: () => ({ ...classes }),
    containers: () => [...current().containers],
    settings,
    /** A code phase's ordinary upload: same bindings and modules, the plan's container links. */
    deployCode(containers: readonly string[]) {
      const previous = current();
      deploy({ ...previous, id: `code-${++serial}`, containers: [...containers] });
    },
  };
}
