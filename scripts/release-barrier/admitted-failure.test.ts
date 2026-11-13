import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { StateStoreError } from "alchemy/State/State";
import { fixture } from "./test/deploy-stack-fixture.ts";
import { releaseEvidence } from "./evidence.ts";
import { reportRefusal } from "./refusal-report.ts";

for (const [scenario, resource, operation] of [
  ["state-read", "Api", "read-native-state"],
  ["state-drift", "Api", "verify-native-state"],
  ["plan", "PoolDatabase", "plan-read-state"],
  ["apply", "PoolDatabase", "apply-database-resource"],
  ["state-write", "PoolDatabase", "apply-write-state"],
  ["journal-write", "fixture-sql-schema-barrier/output", "write-release-journal"],
  ["journal-write-persistent", "fixture-sql-schema-barrier/output", "write-release-journal"],
] as const)
  test(`public stack preserves admitted ${scenario} failure and refuses activation`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), "admitted-failure-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const evidence = releaseEvidence(root, "a".repeat(40));
    const secret = "private-credential@secret.invalid?token=hidden";
    const proof = fixture({
      namespace: "eu",
      evidence,
      admittedFailure: scenario,
      admittedStateError: new StateStoreError({
        message: secret,
        cause: new Error(secret),
        http: { status: 503 },
      }),
      admittedError: Object.assign(new Error(secret), {
        _tag: "ServiceUnavailable",
        status: 503,
        code: 10001,
      }),
    });
    const exit = await Effect.runPromiseExit(proof.effect);
    assert.ok(Exit.isFailure(exit));
    const failure = await evidence.failure(Cause.squash(exit.cause));
    assert.equal(failure.phase, scenario.startsWith("journal-write") ? "schema" : "admitted");
    assert.equal(failure.worker, resource);
    assert.equal(failure.operation, operation);
    assert.equal(
      failure.reason,
      scenario === "state-drift" ? "alchemy-state-drift" : "release-operation-failed",
    );
    if (
      scenario === "state-read" ||
      scenario === "plan" ||
      scenario === "state-write" ||
      scenario.startsWith("journal-write")
    )
      assert.deepEqual(failure.provider, { type: "StateStoreError", status: 503 });
    else if (scenario === "apply")
      assert.deepEqual(failure.provider, {
        type: "ServiceUnavailable",
        status: 503,
        codes: [10001],
      });
    else assert.ok(failure.delta?.changed.some((change) => change.path === "providerVersion"));
    const receipt = proof.receipts.at(-1)!;
    assert.equal(receipt.accepted.length, 2);
    assert.deepEqual(receipt.activated, []);
    if (scenario !== "journal-write-persistent")
      assert.equal(Reflect.get(receipt.failure!, "operation"), operation);
    assert.ok(!proof.events.some((event) => event.startsWith("activate:")));
    const summary = join(root, "summary.md");
    const lines: string[] = [];
    await reportRefusal(failure, summary, (line) => lines.push(line));
    for (const output of [
      ...(scenario === "journal-write-persistent" ? [] : [JSON.stringify(receipt)]),
      await readFile(join(root, "failure.json"), "utf8"),
      await readFile(summary, "utf8"),
      ...lines,
    ]) {
      assert.ok(output.includes(resource), output);
      assert.ok(output.includes(operation), output);
      assert.ok(!output.includes(secret), output);
      assert.ok(!output.includes("secret.invalid"), output);
    }
  });
