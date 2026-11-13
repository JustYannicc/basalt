import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { bucketFixture } from "./retained-frameworks-fixture.ts";
import { retainedFrameworks } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks.ts";
import { retainedFrameworkObjects } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts";
import {
  atPhase,
  diagnostic,
  refusalDiagnostic,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/diagnostics.ts";

const poison = "PRIVATE_provider_key/bld_secret/worker.json?credential=never-retain";
const tokenModule = new URL("../../src/pool/token.ts", import.meta.url).href;

function cli(failure: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "retained-framework-receipt-"));
  const fixture = join(directory, "fetch.mjs");
  writeFileSync(
    fixture,
    `
import assert from 'node:assert/strict';
import { openEnvelope } from ${JSON.stringify(tokenModule)};
globalThis.fetch = async (_url, init) => {
  const signed = await openEnvelope('ab'.repeat(32), 'sbops1', JSON.parse(init.body).envelope);
  assert.equal(signed.operation.action, 'inventory');
  assert.equal(signed.operation.selection, 'retained-frameworks');
  return Response.json(${JSON.stringify({ error: "operation_refused", failure })}, { status: 409 });
};
`,
  );
  const summary = join(directory, "summary.md");
  const result = spawnSync(
    process.execPath,
    ["--import", fixture, "scripts/production-ops/run.ts"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch",
        POOL_APP_SIGNING_KEY: "ab".repeat(32),
        OPS_ACTION: "inventory",
        OPS_SELECTION: "retained-frameworks",
        OPS_REQUEST: '{"organization":"synthetic-organization"}',
        OPS_RECIPIENT: "c3ludGhldGlj",
        OPS_OUTPUT_DIRECTORY: directory,
        GITHUB_STEP_SUMMARY: summary,
      },
    },
  );
  try {
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    return {
      receipt: JSON.parse(readFileSync(join(directory, "failure.json"), "utf8")),
      summary: existsSync(summary) ? readFileSync(summary, "utf8") : "",
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("wrapped runtime refusals reach the signed operator, CI error and summary as closed diagnostics", async () => {
  for (const stalled of [false, true]) {
    const fixture = bucketFixture();
    fixture.bucket.list = () => (stalled ? Effect.never : Effect.fail(new Error(poison)));
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* retainedFrameworks([], retainedFrameworkObjects(fixture.bucket)).pipe(
          atPhase("sql"),
          atPhase("config"),
          Effect.forkChild,
        );
        yield* TestClock.adjust("18 seconds");
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
    );
    assert.ok(Exit.isFailure(exit));
    const failure = diagnostic(exit.cause, "config");
    assert.equal(failure.phase, "sql");
    assert.ok(failure.retainedRead);
    assert.equal(failure.retainedRead.objectClass, "framework_metadata");
    assert.equal(failure.retainedRead.readPhase, "list");
    if (stalled)
      assert.ok(failure.retainedRead.elapsedMs >= 9300 && failure.retainedRead.elapsedMs <= 9360);
    else assert.equal(failure.retainedRead.elapsedMs, 0);
    const guard = refusalDiagnostic(exit.cause, "config");
    assert.equal(failure.reasonCode, guard.reasonCode);
    assert.deepEqual(guard, {
      guard: "retained_frameworks",
      reasonCode: stalled ? "read_timeout" : "unreadable_metadata",
      ...failure.retainedRead,
    });
    await Effect.runPromise(
      Effect.logWarning("production_ops.operation_refused", guard).pipe(
        Effect.provide(fixture.logger),
      ),
    );
    const result = cli(failure);
    assert.deepEqual(result.receipt, { ...failure, httpStatus: 409 });
    const detail = `Retained frameworks refused at framework_metadata/list after ${failure.retainedRead.elapsedMs} ms.`;
    assert.ok(result.stderr.includes(`::error::${detail}`));
    assert.ok(result.summary.includes(detail));
    assert.ok(
      result.summary.includes(
        `Work: 0 references, 0 builds, ${stalled ? 3 : 1} metadata attempts, 0 pages`,
      ),
    );
    assert.ok(!JSON.stringify({ result, guard, logs: fixture.logs }).includes(poison));
  }
});

test("untrusted receipt fields cannot put object keys or paths in CLI diagnostics", () => {
  const safe = { objectClass: "split_record", readPhase: "read", elapsedMs: 123 };
  const base = { format: "basalt-production-ops-failure-v1", category: "refused", phase: "sql" };
  for (const retainedRead of [
    { ...safe, objectClass: poison },
    { ...safe, readPhase: poison },
    { ...safe, elapsedMs: -1 },
    { ...safe, elapsedMs: 86_400_001 },
    { ...safe, elapsedMs: 1.5 },
  ]) {
    const result = cli({
      ...base,
      retainedRead,
      reasonCode: poison,
      message: poison,
      path: poison,
    });
    assert.deepEqual(result.receipt, { ...base, httpStatus: 409 });
    assert.equal(result.summary, "");
    assert.ok(!result.stderr.includes("::error::"));
    assert.ok(!JSON.stringify(result).includes(poison));
  }
  const result = cli({ ...base, retainedRead: { ...safe, path: poison, key: poison } });
  assert.deepEqual(result.receipt, { ...base, retainedRead: safe, httpStatus: 409 });
  assert.ok(!JSON.stringify(result).includes(poison));
});

test("aggregate work diagnostics retain only bounded numeric counters", () => {
  const work = {
    references: 2,
    builds: 1,
    metadataAttempts: 1,
    metadataPages: 1,
    metadataObjects: 3,
    recordAttempts: 2,
    completedBuilds: 0,
  };
  const retainedRead = { objectClass: "split_record", readPhase: "read", elapsedMs: 1000 };
  const base = { format: "basalt-production-ops-failure-v1", category: "refused", phase: "sql" };
  const result = cli({
    ...base,
    retainedRead: { ...retainedRead, work: { ...work, key: poison, path: poison } },
  });
  assert.deepEqual(result.receipt, {
    ...base,
    retainedRead: { ...retainedRead, work },
    httpStatus: 409,
  });
  assert.ok(result.summary.includes("Work: 2 references, 1 builds, 1 metadata attempts"));
  assert.ok(!JSON.stringify(result).includes(poison));
  const malformed = cli({
    ...base,
    retainedRead: { ...retainedRead, work: { ...work, metadataObjects: poison } },
  });
  assert.deepEqual(malformed.receipt, { ...base, retainedRead, httpStatus: 409 });
  assert.ok(!JSON.stringify(malformed).includes(poison));
});
