import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { readClassContent, readDeclaredClass, deployClassExpansion } from "./class-cloudflare.ts";
import { expansionContent, expansionRequest } from "./class-payload.ts";
import { decodeDeclaredChanges } from "./declared-change-schema.ts";

const target = { accountId: "synthetic-account", scriptName: "synthetic-worker" };
const entry = decodeDeclaredChanges({
  schemaVersion: 1,
  stack: "fixture",
  retentionOwner: "Fixture",
  changes: [
    {
      action: "add-sqlite-class",
      type: "Cloudflare.Worker",
      fqn: "AppData",
      newSqliteClasses: ["DriveObject"],
      addedBindings: [
        {
          type: "durable_object_namespace",
          name: "DRIVE",
          className: "DriveObject",
          location: "local",
        },
      ],
      retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
    },
  ],
}).changes[0]!;
const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic-never-sent" } }),
        ),
      ),
    ),
  );

test("active baseline content uses the exact version query and preserves binary and module bytes", async () => {
  const form = new FormData();
  form.set(
    "entry.js",
    new File(["export default {}"], "entry.js", { type: "application/javascript+module" }),
  );
  form.set(
    "binary.wasm",
    new File([new Uint8Array([0, 1, 255])], "binary.wasm", { type: "application/wasm" }),
  );
  const content = await run(
    readClassContent(target, "active-version", async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get("version"), "active-version");
      assert.equal(init?.method, "GET");
      return new Response(form, { headers: { "cf-entrypoint": "entry.js" } });
    }),
  );
  assert.equal(content.mainModule, "entry.js");
  assert.deepEqual([...content.files[1]!.bytes], [0, 1, 255]);
});

test("the real SDK observes a single active version and actual runtime migration tag", async () => {
  const calls: string[] = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      calls.push(request.method + " " + url.pathname);
      const result = url.pathname.endsWith("/deployments")
        ? {
            deployments: [
              {
                id: "deployment",
                created_on: "2026-11-07T00:00:00Z",
                strategy: "percentage",
                versions: [{ version_id: "active", percentage: 100 }],
              },
            ],
          }
        : url.pathname.endsWith("/workers/synthetic-worker")
          ? {
              id: "immutable-worker",
              name: "synthetic-worker",
              created_on: "2026-11-07T00:00:00Z",
              updated_on: "2026-11-07T00:00:00Z",
              logpush: false,
              observability: {},
              references: [],
              subdomain: { enabled: false, previews_enabled: false },
              tags: [],
              tail_consumers: [],
            }
          : { id: "active", resources: { bindings: [], script_runtime: { migration_tag: "1" } } };
      return HttpResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
  const observed = await run(
    readDeclaredClass(target, async () =>
      Response.json({
        success: true,
        errors: [],
        result: { bindings: [], tags: ["alchemy:migration-tag:1"] },
      }),
    ).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make("synthetic-never-sent"),
          apiBaseUrl: "https://api.cloudflare.com/client/v4",
        }),
      ),
    ),
  );
  assert.equal(observed.versionId, "active");
  assert.equal(observed.workerId, "immutable-worker");
  assert.equal(observed.migrationTag, "1");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.startsWith("GET ")));
});

for (const rejected of [false, true])
  test(`the real SDK sends exactly one additive script PUT without tag repair or retry (rejected=${rejected})`, async () => {
    assert.equal(entry.action, "add-sqlite-class");
    if (entry.action !== "add-sqlite-class") return;
    const baseline = {
      ...target,
      versionId: "active",
      workerId: "immutable-worker",
      migrationTag: "1",
      previewUrlsEnabled: false,
      settings: {
        compatibilityDate: "2026-09-08",
        compatibilityFlags: [],
        bindings: [
          { type: "plain_text" as const, name: "SECRET_SETTING", text: "synthetic-private-value" },
        ],
        tags: ["alchemy:migration-tag:1"],
      },
    };
    const content = expansionContent(
      {
        mainModule: "entry.js",
        files: [
          {
            name: "entry.js",
            type: "application/javascript+module",
            bytes: new TextEncoder().encode("export default {}"),
          },
        ],
      },
      entry,
    );
    const request = expansionRequest(
      baseline,
      content,
      entry,
      "2",
      ["alchemy:migration-tag:2"],
      "marker",
    );
    let puts = 0;
    const client = HttpClient.make((wire, url) =>
      Effect.promise(async () => {
        puts++;
        assert.equal(wire.method, "PUT");
        assert.ok(url.pathname.endsWith("/workers/scripts/synthetic-worker"));
        assert.equal(wire.body._tag, "FormData");
        if (wire.body._tag !== "FormData") assert.fail("Expected multipart");
        const part = wire.body.formData.get("metadata");
        assert.ok(part);
        const metadata = JSON.parse(typeof part === "string" ? part : await part.text());
        assert.deepEqual(metadata.migrations, {
          old_tag: "1",
          new_tag: "2",
          new_sqlite_classes: ["DriveObject"],
        });
        assert.deepEqual(metadata.bindings, [
          { type: "inherit", name: "SECRET_SETTING" },
          { type: "durable_object_namespace", name: "DRIVE", class_name: "DriveObject" },
        ]);
        assert.equal(metadata.annotations["workers/message"], "marker");
        assert.ok(!JSON.stringify(metadata).includes("synthetic-private-value"));
        return HttpResponse.fromWeb(
          wire,
          rejected
            ? Response.json(
                { success: false, errors: [{ code: 10002, message: "Synthetic unavailable" }] },
                { status: 500 },
              )
            : Response.json({
                success: true,
                errors: [],
                messages: [],
                result: {
                  id: "synthetic-worker",
                  tag: "immutable-worker",
                  migration_tag: "2",
                  startup_time_ms: 100,
                },
              }),
        );
      }),
    );
    const effect = deployClassExpansion(request).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make("synthetic-never-sent"),
          apiBaseUrl: "https://api.cloudflare.com/client/v4",
        }),
      ),
    );
    if (rejected) await assert.rejects(run(effect));
    else assert.deepEqual(await run(effect), { startupTimeMs: 100, migrationTag: "2" });
    assert.equal(puts, 1);
  });
