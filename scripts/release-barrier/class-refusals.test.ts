import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { classProvisioning } from "./test/declared-class-fixture.ts";
import { reportRefusal } from "./refusal-report.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertClassRequests } from "./class-refusals.ts";
import { preparedUpload } from "./fixture.ts";
import { BarrierRefusal } from "./manifest.ts";

test("all independent concrete request refusals name their logical Worker before any live expansion", () => {
  const uploads = ["First", "Second"].map((fqn) => {
    const upload = preparedUpload(fqn);
    const next = {
      ...upload,
      request: {
        ...upload.request,
        metadata: {
          ...upload.request.metadata,
          migrations: { newSqliteClasses: ["Undeclared"] },
        },
      },
    };
    return [fqn, next] as const;
  });
  assert.throws(
    () => assertClassRequests({ captured: new Map(uploads) }, [], {}),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.deepEqual(
        error.refusals?.map((refusal) => ("fqn" in refusal ? refusal.fqn : null)),
        ["First", "Second"],
      );
      assert.ok(
        error.refusals?.every((refusal) => "changed" in refusal && refusal.changed.length > 0),
      );
      return true;
    },
  );
});

test("every independent live immutable Worker mismatch reaches the error and summary before mutation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "class-refusal-summary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const proof = classProvisioning({
    foreignLiveWorker: true,
    secondForeignWorker: true,
    expectedFailure: /native-target-drift/,
  });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.events, []);
  assert.equal(proof.cloneState().staged, 0);
  const failure = proof.failures[0];
  assert.ok(failure instanceof BarrierRefusal);
  assert.deepEqual(failure.refusals?.map((item) => ("fqn" in item ? item.fqn : null)).sort(), [
    "AppData",
    "OtherData",
  ]);
  const errors: string[] = [];
  const summary = join(root, "summary.md");
  await reportRefusal(failure, summary, (message) => {
    errors.push(message);
  });
  for (const output of [errors.join("\n"), await readFile(summary, "utf8")]) {
    assert.ok(output.includes("AppData"));
    assert.ok(output.includes("OtherData"));
    assert.ok(output.includes("workerIdentityHash"));
    assert.ok(!output.includes("replacement-worker"));
  }
});

test("post-deployment startup refusal reports its ceiling and observed duration in both outputs", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "class-startup-summary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const proof = classProvisioning({
    startupTimeMs: 751,
    expectedFailure: /post-deployment-startup-refused/,
  });
  await Effect.runPromise(proof.effect);
  const failure = proof.failures[0];
  assert.ok(failure instanceof BarrierRefusal);
  const errors: string[] = [];
  const summary = join(root, "summary.md");
  await reportRefusal(failure, summary, (message) => {
    errors.push(message);
  });
  for (const output of [errors.join("\n"), await readFile(summary, "utf8")]) {
    assert.ok(output.includes("AppData"));
    assert.ok(output.includes("startupTimeMs"));
    assert.ok(output.includes("750"));
    assert.ok(output.includes("751"));
  }
});

test("request and live-baseline refusals are collected together before any mutation", async () => {
  const proof = classProvisioning({
    foreignLiveWorker: true,
    secondForeignWorker: true,
    deletedClass: true,
    expectedFailure: /migration-mismatch/,
  });
  await Effect.runPromise(proof.effect);
  const failure = proof.failures[0];
  assert.ok(failure instanceof BarrierRefusal);
  assert.deepEqual(
    new Set(failure.refusals?.map((item) => item.reason)),
    new Set(["declared-class-migration-mismatch", "declared-class-native-target-drift"]),
  );
  assert.deepEqual(
    new Set(failure.refusals?.map((item) => ("fqn" in item ? item.fqn : null))),
    new Set(["AppData", "OtherData"]),
  );
  assert.equal(proof.cloneState().staged, 0);
  assert.deepEqual(proof.events, []);
});
