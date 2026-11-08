import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";

const target = { accountId: "synthetic-account", scriptName: "synthetic-worker" };
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

for (const rejected of [false, true])
  test(`the real SDK stages one inactive clone without retry, reads modules and deletes only its id (rejected=${rejected})`, async () => {
    const { cloneRequest } = await import("./class-clone.ts");
    const { stageClassClone, readClassClone, deleteClassClone } =
      await import("./class-cloudflare.ts");
    const baseline = {
      ...target,
      versionId: "exact-active",
      workerId: "immutable-worker",
      migrationTag: "1",
      previewUrlsEnabled: false,
      settings: {
        bindings: [{ type: "secret_text" as const, name: "TOKEN", text: "synthetic-private" }],
        compatibilityDate: "2026-09-08",
        tags: ["alchemy:migration-tag:1"],
      },
    };
    const request = cloneRequest(
      baseline,
      {
        mainModule: "main.js",
        files: [
          {
            name: "main.js",
            type: "application/javascript+module",
            bytes: new Uint8Array([0, 255, 1]),
          },
        ],
      },
      "fixture-clone",
    );
    const calls: string[] = [];
    const client = HttpClient.make((wire, url) =>
      Effect.sync(() => {
        calls.push(wire.method);
        assert.ok(url.pathname.includes("/workers/workers/synthetic-worker/versions"));
        if (wire.method === "POST") {
          assert.equal(url.searchParams.get("deploy"), "false");
          assert.equal(wire.body._tag, "Uint8Array");
          if (wire.body._tag !== "Uint8Array") assert.fail("Expected JSON");
          const body = JSON.parse(Buffer.from(wire.body.body).toString());
          assert.deepEqual(body.bindings, [
            { type: "inherit", name: "TOKEN", version_id: "exact-active" },
          ]);
          assert.deepEqual(body.modules, [
            {
              name: "main.js",
              content_type: "application/javascript+module",
              content_base64: "AP8B",
            },
          ]);
          assert.ok(!body.migrations);
          assert.ok(!body.exports);
        } else {
          assert.ok(url.pathname.endsWith("/clone-id"));
          if (wire.method === "GET") assert.equal(url.searchParams.get("include"), "modules");
        }
        if (rejected)
          return HttpResponse.fromWeb(
            wire,
            Response.json(
              { success: false, errors: [{ code: 10002, message: "Synthetic unavailable" }] },
              { status: 500 },
            ),
          );
        return HttpResponse.fromWeb(
          wire,
          Response.json({
            success: true,
            errors: [],
            messages: [],
            result:
              wire.method === "DELETE"
                ? {}
                : { id: "clone-id", number: 2, created_on: "2026-11-07T00:00:00Z", urls: [] },
          }),
        );
      }),
    );
    const effect = Effect.gen(function* () {
      assert.deepEqual(yield* stageClassClone(request), { versionId: "clone-id" });
      assert.equal((yield* readClassClone(target, "clone-id"))?.id, "clone-id");
      yield* deleteClassClone(target, "clone-id");
    }).pipe(
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
    else await run(effect);
    assert.deepEqual(calls, rejected ? ["POST"] : ["POST", "GET", "DELETE"]);
  });

test("the real SDK recognizes an absent version without treating a missing Worker as successful cleanup", async () => {
  const { readClassClone } = await import("./class-cloudflare.ts");
  for (const code of [10071, 10007]) {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpResponse.fromWeb(
          request,
          Response.json(
            { success: false, errors: [{ code, message: "Synthetic absent" }] },
            { status: 404 },
          ),
        ),
      ),
    );
    const effect = readClassClone(target, "clone-id").pipe(
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
    if (code === 10071) assert.equal(await run(effect), undefined);
    else await assert.rejects(run(effect));
  }
});
