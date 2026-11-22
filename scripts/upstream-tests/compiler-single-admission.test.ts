import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { version1, version2, withScenario } from "./catalog-resource-retry-fixture.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const runtime = await load("apps/hosted/cloud/src/implementation/compiler-runtime.ts");

test("the compiler admits one build per isolate", () => {
  // Two Obsidian vault installs at once ran out of the isolate's memory on production (#1644).
  assert.equal(runtime.compilerBuildSlots, 1);
  assert.equal(typeof runtime.compilerAdmission, "function", "compilerRuntime's own admission");
});

test("two concurrent installs: the second waits for the first and both succeed", async () => {
  const admitted = runtime.compilerAdmission();
  const events: string[] = [];
  const install = (name: string) =>
    admitted(
      Effect.gen(function* () {
        events.push(`${name} start`);
        yield* Effect.sleep("300 millis");
        events.push(`${name} end`);
        return name;
      }),
    );
  const started = Date.now();
  const results = await Effect.runPromise(
    Effect.all([install("first"), install("second")], { concurrency: "unbounded" }),
  );
  assert.deepEqual(results, ["first", "second"]);
  assert.deepEqual(events, ["first start", "first end", "second start", "second end"]);
  assert.ok(Date.now() - started >= 600, "the second build waited for the first");
});

test("a sweep that meets BuildBusy retries the job later without touching the apps", async () => {
  await withScenario({ memoryFailures: 0, busy: true }, (scenario) =>
    Effect.gen(function* () {
      yield* scenario.execute;
      const row = (yield* scenario.row)[0]!;
      assert.equal(row.status, "queued", "the organization's job is retried, not failed");
      assert.equal(row.attempts, 1);
      assert.equal(Number(row.delay_seconds), 2, "with the job's ordinary backoff");
      assert.equal(scenario.state.apps.get("alpha")!.active, version1);
      assert.equal(scenario.state.apps.get("beta")!.active, version2, "the sibling still updates");
    }),
  );
});
