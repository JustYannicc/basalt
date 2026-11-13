import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeHelpers } from "../../node_modules/alchemy/lib/Cloudflare/R2/BucketBinding.js";
import { makeRead } from "alchemy/Cloudflare/R2";
import { retainedFrameworks } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks.ts";
import { retainedFrameworkObjects } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts";
import {
  encoded,
  metadata,
  moduleText,
  nativeBody,
  record,
} from "./retained-frameworks-fixture.ts";

for (const transient of [false, true])
  test(`the installed native R2 adapter ${transient ? "retries a wrapped timeout" : "keeps an unclassified Error final"}`, async () => {
    const identity = { version: "1.2.3", sha256: "a".repeat(64) };
    const body = encoded(record(identity));
    let calls = 0;
    const native = {
      list: async () => ({
        objects: [metadata(identity.version, identity.sha256)],
        truncated: false,
        delimitedPrefixes: [],
      }),
      get: async () => {
        calls++;
        if (calls === 1)
          throw transient ? new DOMException(moduleText, "TimeoutError") : new Error(moduleText);
        return { size: body.byteLength, body: nativeBody(body) };
      },
    };
    // The binding helper reads only LogicalId; the fixture never creates an Alchemy resource.
    const descriptor = { LogicalId: "FixtureAppBuilds" } as Parameters<typeof makeHelpers>[1];
    const bucket = makeRead(makeHelpers({ FixtureAppBuilds: native }, descriptor));
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* retainedFrameworks(
          [{ app: "app_one", deployment: "dpl_one", build: "bld_one" }],
          retainedFrameworkObjects(bucket),
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust("18 seconds");
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
    );
    assert.ok(Exit.isSuccess(exit));
    assert.equal(exit.value.complete, transient);
    assert.equal(calls, transient ? 2 : 1);
    assert.ok(!JSON.stringify(exit.value).includes(moduleText));
  });
