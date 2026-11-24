import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Fiber } from "effect";
import { version1, version2, withScenario } from "./catalog-resource-retry-fixture.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const runtime = await load("apps/hosted/cloud/src/implementation/compiler-runtime.ts");

type Admission = <A, E>(build: Effect.Effect<A, E>) => Effect.Effect<A, E>;
type Compiler = {
  readonly compile: (
    files: ReadonlyArray<{ path: string; content: string }>,
    publicPaths: ReadonlyArray<string>,
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<{ readonly ok: boolean }>;
};

test("two concurrent compiles through the real compiler: the second is admitted after the first", async () => {
  // The framework read happens inside the admitted compile, so a compile holding its slot on that
  // read shows how many compiles the isolate lets in at once.
  process.env.EXECUTOR_APPS_VERSION = "1.0.0";
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const env = {
    ASSETS: {
      fetch: async () => {
        reads++;
        await held;
        return new Response("{}");
      },
    },
  };
  const compiler = (await Effect.runPromise(runtime.compilerRuntime(env))) as Compiler;
  const files = [
    { path: "package.json", content: JSON.stringify({ dependencies: { apps: "1.0.0" } }) },
    { path: "index.ts", content: "export default {};" },
  ];
  const first = Effect.runFork(compiler.compile(files, [], {}));
  const second = Effect.runFork(compiler.compile(files, [], {}));
  await new Promise((resolve) => setTimeout(resolve, 300));
  // Before 0733 the isolate admitted two builds: both were reading the framework here.
  assert.equal(reads, 1, "only the first compile is admitted while it runs");
  release();
  const results = await Promise.all(
    [first, second].map((fiber) => Effect.runPromise(Fiber.join(fiber))),
  );
  assert.equal(results.length, 2, "the second compile still runs once the first is released");
  delete process.env.EXECUTOR_APPS_VERSION;
});

test("two concurrent installs: the second waits for the first and both succeed", async () => {
  const admitted = runtime.compilerAdmission() as Admission;
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
