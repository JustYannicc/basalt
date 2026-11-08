import * as Workers from "@distilled.cloud/cloudflare/workers";
import assert from "node:assert/strict";
import type { ClassProvider, ClassObservation } from "../declared-class-contract.ts";
import { attributes } from "../fixture.ts";
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";

export interface ClassApiOptions {
  loseReply?: boolean;
  failObservationOnce?: boolean;
  foreignMarker?: boolean;
  startupTimeMs?: number;
  loseCloneReply?: boolean;
  refuseAfterClone?: boolean;
  previewsEnabled?: boolean;
  foreignLiveWorker?: boolean;
  loseDeleteReply?: boolean;
  deleteApplied?: boolean;
  numericClassPlacement?: boolean;
  classPlacementDrift?: boolean;
}

export function classRecoveryClient(events: string[]) {
  let active = "accepted";
  return HttpClient.make((request, url) =>
    Effect.sync(() => {
      let result: unknown;
      if (request.method === "POST") {
        events.push("recover-version");
        assert.ok(url.pathname.endsWith("/deployments"));
        assert.equal(request.body._tag, "Uint8Array");
        if (request.body._tag !== "Uint8Array") assert.fail("Expected deployment JSON");
        active = JSON.parse(Buffer.from(request.body.body).toString()).versions[0].version_id;
        result = {
          id: "recovery",
          created_on: "2026-11-07T00:00:00Z",
          strategy: "percentage",
          versions: [{ version_id: active, percentage: 100 }],
        };
      } else {
        assert.equal(request.method, "GET");
        if (url.pathname.endsWith("/deployments"))
          result = {
            deployments: [
              {
                id: "active",
                created_on: "2026-11-07T00:00:00Z",
                strategy: "percentage",
                versions: [{ version_id: active, percentage: 100 }],
              },
            ],
          };
        else if (url.pathname.endsWith("/settings"))
          result = {
            tags: ["alchemy:migration-tag:2"],
            bindings: [
              {
                type: "durable_object_namespace",
                name: "DRIVE",
                class_name: "DriveObject",
                namespace_id: "namespace-drive",
              },
            ],
          };
        else if (url.pathname.includes("/workers/workers/"))
          result = {
            id: "AppData",
            name: "AppData",
            created_on: "2026-11-07T00:00:00Z",
            updated_on: "2026-11-07T00:00:00Z",
            logpush: false,
            observability: {},
            references: [],
            subdomain: { enabled: false, previews_enabled: false },
            tags: [],
            tail_consumers: [],
          };
        else {
          assert.ok(url.pathname.includes("/versions/"));
          const version = url.pathname.split("/").at(-1);
          result = {
            id: version,
            resources: {
              bindings: [
                {
                  type: "durable_object_namespace",
                  name: "DRIVE",
                  namespace_id: "namespace-drive",
                },
              ],
              script_runtime: { migration_tag: version === "pre-expansion" ? "1" : "2" },
              script: { named_handlers: [{ name: "DriveObject", handlers: [] }] },
            },
          };
        }
      }
      return HttpResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
}

export function classApi(events: string[], options: ClassApiOptions) {
  let expanded = false;
  let clone: Workers.GetBetaWorkerVersionResponse | undefined;
  let staged = 0;
  let removed = 0;
  const cloneEvents: string[] = [];
  let emptySource = "";
  let marker = "";
  let missingNamespace = false;
  let failedObservation = false;
  let expandedFiles: { name: string; type: string; bytes: Uint8Array }[] = [];
  const settings = (): ClassObservation["settings"] =>
    Schema.decodeUnknownSync(Schema.toType(Workers.GetScriptScriptAndVersionSettingResponse))({
      ...(options.numericClassPlacement ? { placement: { mode: "targeted", target: [39] } } : {}),
      compatibilityDate: "2026-09-08",
      compatibilityFlags: [],
      bindings:
        expanded && !missingNamespace
          ? [
              {
                type: "durable_object_namespace",
                name: "DRIVE",
                className: "DriveObject",
                namespaceId: "namespace-drive",
              },
            ]
          : [],
      tags: [`alchemy:migration-tag:${expanded ? 2 : 1}`],
      annotations: expanded ? { workersMessage: options.foreignMarker ? "foreign" : marker } : {},
    });
  const provider: ClassProvider = {
    read: async (target) => {
      if (expanded && options.failObservationOnce && !failedObservation) {
        failedObservation = true;
        throw new Error("Synthetic observation failure");
      }
      return {
        workerId: options.foreignLiveWorker ? "replacement-worker" : target.scriptName,
        accountId: target.accountId,
        scriptName: target.scriptName,
        versionId: expanded ? "expanded" : "previous",
        migrationTag: expanded ? "2" : "1",
        settings: settings(),
        previewUrlsEnabled: options.previewsEnabled ?? false,
      };
    },
    content: async (_target, version) => ({
      mainModule: "main.js",
      files:
        version === "expanded"
          ? expandedFiles
          : [
              {
                name: "main.js",
                type: "application/javascript+module",
                bytes: new TextEncoder().encode(
                  "export default { fetch() { return new Response('baseline'); } };\n",
                ),
              },
            ],
    }),
    stageClone: async (request) => {
      staged++;
      cloneEvents.push("stage");
      assert.equal(expanded, false);
      assert.equal(request.deploy, false);
      assert.ok(!request.migrations);
      assert.equal(request.modules?.length, 1);
      assert.ok(
        request.bindings?.every(
          (binding) => binding.type === "inherit" && binding.versionId === "previous",
        ),
      );
      clone = Schema.decodeUnknownSync(Schema.toType(Workers.GetBetaWorkerVersionResponse))({
        ...request,
        id: "baseline-clone",
        createdOn: "2026-11-07T00:00:00Z",
        number: 2,
        urls: [],
        bindings: settings().bindings,
      });
      if (options.loseCloneReply && staged === 1) throw new Error("Synthetic lost clone response");
      return { versionId: clone.id };
    },
    clone: async (_target, id) => {
      if (options.refuseAfterClone && clone) throw new Error("Synthetic refusal after clone");
      return clone && (id === "latest" || id === clone.id) ? clone : undefined;
    },
    removeClone: async (_target, id) => {
      assert.equal(id, clone?.id);
      assert.notEqual(id, expanded ? "expanded" : "previous");
      assert.deepEqual(clone?.urls, []);
      removed++;
      cloneEvents.push("remove");
      if (options.loseDeleteReply) {
        if (options.deleteApplied) clone = undefined;
        throw new Error("Synthetic lost delete response");
      }
      clone = undefined;
    },
    deploy: async (request) => {
      assert.ok(clone);
      assert.equal(expanded, false);
      assert.deepEqual(clone.urls, []);
      events.push("expand");
      assert.deepEqual(request.metadata.migrations, {
        oldTag: "1",
        newTag: "2",
        newSqliteClasses: ["DriveObject"],
      });
      assert.ok(Array.isArray(request.files));
      assert.ok(
        (await request.files[0]!.text()).startsWith(
          "export default { fetch() { return new Response('baseline'); } };",
        ),
      );
      assert.ok(!(await request.files[0]!.text()).includes("candidate"));
      emptySource = await request.files[1]!.text();
      expandedFiles = await Promise.all(
        request.files.map(async (file) => {
          assert.ok(file instanceof File);
          return {
            name: file.name,
            type: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
          };
        }),
      );
      marker = request.metadata.annotations?.workersMessage ?? "";
      expanded = true;
      if (options.loseReply) throw new Error("Synthetic lost response");
      return { startupTimeMs: options.startupTimeMs ?? 100, migrationTag: "2" };
    },
  };
  return {
    provider,
    settings,
    cloneState: () => ({
      staged,
      removed,
      retained: clone ? 1 : 0,
      urls: clone?.urls ?? [],
      cloneEvents,
      active: expanded ? "expanded" : "previous",
    }),
    expanded: () => expanded,
    emptyClassSource: () => emptySource,
    removeNamespace() {
      missingNamespace = true;
    },
    attributes: (id: string) => ({
      ...attributes(id),
      tags: settings().tags ?? [],
      durableObjectNamespaces: Object.fromEntries(
        expanded ? [["DriveObject", "namespace-drive"]] : [],
      ),
    }),
  };
}
