import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Schema } from "effect";
import {
  current,
  job,
  version1,
  version2,
  withScenario,
} from "./catalog-resource-retry-fixture.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const { RuntimeBuildFailed } = await load("packages/sdk/src/contracts/runtime.ts");
const { VersionBuildFailed } = await load("packages/sdk/src/contracts/version.ts");
const { versionBuildFailed } = await load(
  "packages/sdk/src/implementation/version-build-failure.ts",
);
const { retryCompilerRequest } = await load(
  "apps/hosted/cloud/src/implementation/compiler-resource-retry.ts",
);
const { RpcCallError } = await import(
  new URL("../../.upstream/apps/hosted/cloud/node_modules/alchemy/lib/Rpc.js", import.meta.url).href
);

test("compiler retry leaves memory-like non-memory RPC errors as one attempt", async () => {
  let calls = 0;
  const exit = await Effect.runPromiseExit(
    retryCompilerRequest(
      Effect.tryPromise({
        try: async () => {
          calls++;
          throw new Error("Worker exceeded memory limit after source validation");
        },
        catch: (cause) => new RpcCallError({ method: "compile", cause }),
      }),
    ),
  );
  assert.equal(calls, 1, "only the exact worker memory-limit response is retried");
  assert.ok(Exit.isFailure(exit));
  assert.ok(Schema.is(RuntimeBuildFailed)(Cause.squash(exit.cause)));
});
test("catalog compiler memory failures retry the persisted job after sibling upgrades", async () => {
  await withScenario({ memoryFailures: 2 }, (scenario) =>
    Effect.gen(function* () {
      yield* scenario.execute;
      const first = (yield* scenario.row)[0]!;
      assert.equal(first.status, "queued");
      assert.equal(first.attempts, 1);
      assert.equal(Number(first.delay_seconds), 2, "first failure persists the 2 second backoff");
      const firstRecords = (yield* scenario.record)[0]!.apps;
      assert.equal(
        firstRecords.alpha?.version,
        version1,
        "failed app retains its old catalog record",
      );
      assert.equal(
        firstRecords.beta?.version,
        version2,
        `later sibling upgrades before the retry; logs=${JSON.stringify(scenario.logs)}`,
      );
      assert.equal(scenario.state.apps.get("alpha")!.active, version1);
      assert.equal(scenario.state.apps.get("alpha")!.workspaceCommit, "alpha-c1");
      assert.deepEqual(yield* scenario.links, [
        {
          requirement: "crm",
          scope: "user",
          subject: "member-a",
          account: "alpha-account",
          provider: "provider-crm",
        },
      ]);
      assert.deepEqual(scenario.state.counters(), { compilerCalls: 3, buildCalls: 2 });
      assert.equal(
        scenario.incidents.length,
        1,
        "the exhausted compiler request reports one resource incident",
      );

      // Control due time explicitly so a busy test host cannot consume the real 2-second delay.
      yield* scenario.sql`update hosted_provisioning set available_at = now() + interval '1 day' where id = ${job}`;
      yield* scenario.execute;
      assert.equal(
        (yield* scenario.row)[0]!.attempts,
        1,
        "a drain does not claim a job before backoff expires",
      );

      yield* scenario.sql`update hosted_provisioning set available_at = now() where id = ${job}`;
      yield* scenario.execute;
      const retried = (yield* scenario.row)[0]!;
      assert.equal(retried.status, "succeeded");
      assert.equal(retried.attempts, 2);
      assert.equal(scenario.state.apps.get("alpha")!.active, version2);
      assert.deepEqual(scenario.state.apps.get("alpha")!.workspaceFiles, current);
      assert.deepEqual(scenario.state.counters(), { compilerCalls: 4, buildCalls: 3 });
      const finalRecords = (yield* scenario.record)[0]!.apps;
      assert.equal(finalRecords.alpha?.version, version2);
      assert.equal(
        finalRecords.beta?.version,
        version2,
        "the sibling is not redeployed by the retry",
      );
      assert.equal(scenario.state.apps.get("beta")!.versions.size, 2);
      assert.deepEqual(yield* scenario.links, [
        {
          requirement: "crm",
          scope: "user",
          subject: "member-a",
          account: "alpha-account",
          provider: "provider-crm",
        },
      ]);
    }),
  );
});

test("persistent memory failures stop at eight attempts without changing the active version", async () => {
  await withScenario({ memoryFailures: 0, persistent: true }, (scenario) =>
    Effect.gen(function* () {
      for (let attempt = 1; attempt <= 8; attempt++) {
        if (attempt > 1)
          yield* scenario.sql`update hosted_provisioning set available_at = now() where id = ${job}`;
        yield* scenario.execute;
        const row = (yield* scenario.row)[0]!;
        assert.equal(row.attempts, attempt);
        assert.equal(row.status, attempt === 8 ? "failed" : "queued");
        if (attempt < 8) assert.equal(Number(row.delay_seconds), Math.min(300, 2 ** attempt));
      }
      assert.equal(scenario.state.apps.get("alpha")!.active, version1);
      assert.equal(scenario.state.apps.get("beta")!.active, version2);
      assert.deepEqual(scenario.state.counters(), { compilerCalls: 17, buildCalls: 9 });
      assert.equal((yield* scenario.record)[0]!.apps.alpha.version, version1);
      yield* scenario.sql`update hosted_provisioning set available_at = now() where id = ${job}`;
      yield* scenario.execute;
      assert.equal(
        (yield* scenario.row)[0]!.attempts,
        8,
        "a terminal job is not reopened by a later drain",
      );
    }),
  );
});

test("invalid source remains a successful permanent skip", async () => {
  await withScenario({ memoryFailures: 0, invalidSource: true }, (scenario) =>
    Effect.gen(function* () {
      yield* scenario.execute;
      const row = (yield* scenario.row)[0]!;
      assert.equal(row.status, "succeeded");
      assert.equal(row.attempts, 1);
      assert.equal(scenario.state.apps.get("alpha")!.active, version1);
      assert.equal(scenario.state.apps.get("beta")!.active, version2);
      assert.equal((yield* scenario.record)[0]!.apps.alpha.version, version1);
    }),
  );
});

test("deployment compiler deadlines retain their classification through the public error schema", () => {
  const failure = versionBuildFailed(
    "organization:team",
    "alpha",
    new RuntimeBuildFailed({
      stage: "compile",
      message: "The compiler did not answer",
      unanswered: true,
    }),
  );
  const decoded = Schema.decodeUnknownSync(VersionBuildFailed)(JSON.parse(JSON.stringify(failure)));
  assert.equal(decoded.unanswered, true);
  assert.equal(decoded._tag, "VersionBuildFailed");
});

test("a deployment compiler deadline retries after requirements succeeded", async () => {
  await withScenario({ memoryFailures: 0, deploymentUnanswered: true }, (scenario) =>
    Effect.gen(function* () {
      yield* scenario.execute;
      const first = (yield* scenario.row)[0]!;
      assert.equal(first.status, "queued");
      assert.equal(first.attempts, 1);
      assert.equal(Number(first.delay_seconds), 2);
      assert.equal(scenario.state.apps.get("alpha")!.active, version1);
      assert.equal(scenario.state.apps.get("alpha")!.workspaceCommit, "alpha-c1");
      assert.equal(scenario.state.apps.get("beta")!.active, version2);
      assert.equal(scenario.incidents.length, 1);
      assert.equal((yield* scenario.record)[0]!.apps.alpha.version, version1);
      yield* scenario.sql`update hosted_provisioning set available_at = now() where id = ${job}`;
      yield* scenario.execute;
      assert.equal((yield* scenario.row)[0]!.status, "succeeded");
      assert.equal((yield* scenario.row)[0]!.attempts, 2);
      assert.equal(scenario.state.apps.get("alpha")!.active, version2);
      assert.equal(scenario.state.apps.get("beta")!.versions.size, 2);
      assert.deepEqual(yield* scenario.links, [
        {
          requirement: "crm",
          scope: "user",
          subject: "member-a",
          account: "alpha-account",
          provider: "provider-crm",
        },
      ]);
    }),
  );
});
