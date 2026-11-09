import { CloudflareHttpError } from "@distilled.cloud/cloudflare/Errors";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseEvidence } from "./evidence.ts";
import { reportRefusal } from "./refusal-report.ts";
import { fixture } from "./test/deploy-stack-fixture.ts";
import { BarrierRefusal } from "./manifest.ts";

for (const planFailure of ["read", "diff"] as const)
  test(`plan ${planFailure} refusal retains its logical resource and safe provider error`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "plan-cause-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const privateText = "secret-value@private.example";
    const proof = fixture({
      planFailure,
      planError: Object.assign(new Error(privateText), { _tag: "Unauthorized", status: 401 }),
    });
    const exit = await Effect.runPromiseExit(proof.effect);
    assert.ok(Exit.isFailure(exit));
    const failure = await releaseEvidence(directory, "a".repeat(40)).failure(
      Cause.squash(exit.cause),
    );
    assert.equal(failure.worker, "Router");
    assert.equal(Reflect.get(failure, "operation"), `plan-${planFailure}-resource`);
    assert.deepEqual(Reflect.get(failure, "provider"), { type: "Unauthorized", status: 401 });
    const lines: string[] = [];
    await reportRefusal(failure, undefined, (line) => lines.push(line));
    assert.match(lines.join("\n"), /Router/);
    assert.ok(!lines.join("\n").includes(privateText));
    assert.deepEqual(proof.events, []);
    assert.equal(proof.writes(), 0);
  });

test("real Alchemy graph refuses a late upload without activating, executing Commands or committing live state", async () => {
  const proof = fixture({ reject: true });
  await assert.rejects(Effect.runPromise(proof.effect), /upload-rejected-or-unconfirmed/);
  assert.deepEqual(proof.events, ["validate:Api", "validate:Router"]);
  assert.equal(proof.writes(), 0);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
});

test("real Alchemy graph activates accepted IDs before the Api.hash-dependent live verifier", async () => {
  const proof = fixture();
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.events, [
    "validate:Api",
    "validate:Router",
    "command:node ensure-pool-database.ts",
    "activate:Api:accepted-Api",
    "activate:Router:accepted-Router",
    "command:node verify-database-budget.ts",
  ]);
  assert.ok(proof.writes() > 0);
});

for (const cyclicImage of ["changed", "unchanged"] as const)
  test(`finalization starts a cyclic ${cyclicImage} image from the verified candidate outputs`, async () => {
    const proof = fixture({ cyclicImage });
    await Effect.runPromise(proof.effect);
    assert.equal(proof.receipts.at(-1)?.phase, "complete");
    assert.deepEqual(
      proof.events.filter((event) => event.startsWith("activate:")),
      ["activate:Api:accepted-Api", "activate:Router:accepted-Router"],
    );
    assert.ok(!proof.events.some((event) => event.startsWith("ordinary-upload:")));
  });

for (const finalizeDrift of ["binding", "uncovered-env", "props"] as const)
  for (const cyclicImage of [undefined, "changed", "unchanged"] as const)
    test(`finalization still refuses changed ${finalizeDrift} inputs after activation (image=${cyclicImage ?? "acyclic"})`, async () => {
      const proof = fixture({ finalizeDrift, cyclicImage });
      const exit = await Effect.runPromiseExit(proof.effect);
      assert.ok(Exit.isFailure(exit));
      const failure = Cause.squash(exit.cause);
      assert.ok(failure instanceof BarrierRefusal);
      assert.equal(failure.reason, "activation-input-drift");
      assert.equal(failure.worker, "Router");
      assert.ok(failure.delta?.changed.length);
      const table = JSON.stringify(failure.delta);
      assert.match(table, finalizeDrift === "binding" ? /bindings/ : /news/);
      assert.ok(proof.events.includes("activate:Router:accepted-Router"));
    });

for (const options of [{ newResource: true }, { omitCapture: true }]) {
  test(`incomplete preparation ${JSON.stringify(options)} never reaches upload or activation`, async () => {
    const proof = fixture(options);
    await assert.rejects(Effect.runPromise(proof.effect));
    assert.deepEqual(proof.events, []);
    assert.equal(proof.writes(), 0);
  });
}

for (const reject of [false, true]) {
  test(`an existing interrupted in-place update resumes through the barrier (rejected=${reject})`, async () => {
    const proof = fixture({ interrupted: true, reject });
    if (reject)
      await assert.rejects(Effect.runPromise(proof.effect), /upload-rejected-or-unconfirmed/);
    else await Effect.runPromise(proof.effect);
    assert.equal(proof.seededStatus(), "updating");
    if (reject) {
      assert.equal(proof.writes(), 0);
      assert.deepEqual(proof.events, ["validate:Api", "validate:Router"]);
    } else assert.equal(proof.receipts.at(-1)?.phase, "complete");
  });
}

for (const namespace of ["missing", "wrong", "drift"] as const) {
  test(`namespace ${namespace} refuses before any Worker activation or provisioning`, async () => {
    const proof = fixture({ namespace });
    await assert.rejects(Effect.runPromise(proof.effect), /source-namespace/);
    assert.ok(
      !proof.events.some((event) => event.startsWith("activate:") || event.startsWith("command:")),
    );
    if (namespace !== "drift") {
      assert.ok(!proof.events.some((event) => event.startsWith("validate:")));
      assert.equal(proof.writes(), 0);
    }
  });
}
test("existing EU namespace is admitted before uploads and rechecked before activation without running its provisioning Command", async () => {
  const proof = fixture({ namespace: "eu" });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.events[0], "namespace:read");
  const second = proof.events.indexOf("namespace:read", 1);
  assert.ok(second > proof.events.indexOf("validate:Router"));
  assert.ok(second < proof.events.findIndex((event) => event.startsWith("activate:")));
  assert.ok(!proof.events.some((event) => event.includes("command:node ensure-artifacts.ts")));
});
test("an unsupported Command cannot be deferred through preparation", async () => {
  const proof = fixture({ unknownCommand: true });
  await assert.rejects(Effect.runPromise(proof.effect), /unsupported-command/);
  assert.deepEqual(proof.events, []);
  assert.equal(proof.writes(), 0);
});

test("database Commands outside the explicit database dependency plan cannot run after activation", async () => {
  const proof = fixture({ orphanedDatabaseCommand: true });
  await assert.rejects(Effect.runPromise(proof.effect), /unsafe-database-selection/);
  assert.deepEqual(proof.events, ["validate:Api", "validate:Router"]);
  assert.equal(proof.writes(), 0);
});

for (const [field, operation] of [
  ["baselineError", "read-worker-baseline"],
  ["preparationError", "prepare-resource"],
  ["freezeError", "freeze-worker-upload"],
] as const) {
  test(`public deployStack retains a safe ${operation} cause through Effect and Promise`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "release-cause-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const secret = "credential@private.example/worker?token=private-value";
    const proof = fixture({
      [field]: Object.assign(
        new CloudflareHttpError({ status: 503, statusText: secret, message: secret, body: secret }),
        { code: 10001, request: secret, stack: secret },
      ),
    });
    const exit = await Effect.runPromiseExit(proof.effect);
    assert.ok(Exit.isFailure(exit));
    const evidence = releaseEvidence(directory, "a".repeat(40));
    const failure = await evidence.failure(Cause.squash(exit.cause));
    assert.equal(failure.reason, "release-operation-failed");
    assert.equal(failure.worker, "Api");
    assert.equal(Reflect.get(failure, "operation"), operation);
    assert.deepEqual(Reflect.get(failure, "provider"), {
      type: "CloudflareHttpError",
      status: 503,
      codes: [10001],
    });
    const lines: string[] = [];
    const summary = join(directory, "summary.md");
    await reportRefusal(failure, summary, (line) => lines.push(line));
    const outputs = [
      await readFile(join(directory, "failure.json"), "utf8"),
      await readFile(summary, "utf8"),
      ...lines,
    ];
    for (const output of outputs) {
      for (const expected of ["Api", operation, "CloudflareHttpError", "503", "10001"])
        assert.ok(output.includes(expected), `${expected} absent from ${output}`);
      for (const privatePart of [secret, "private.example", "private-value"])
        assert.ok(!output.includes(privatePart));
    }
    assert.deepEqual(proof.events, []);
    assert.equal(proof.writes(), 0);
  });
}

test("the exact damaged Api repair preserves non-default script settings through real activation readback", async () => {
  const proof = fixture({ placementRepair: true });
  await Effect.runPromise(proof.effect);
  const before = proof.events.indexOf("repair-settings:before");
  const activated = proof.events.indexOf("activate:Api:accepted-Api");
  const after = proof.events.indexOf("repair-settings:after");
  assert.ok(before >= 0 && before < activated && after > activated);
  assert.ok(proof.events.includes("repair-version:accepted-Api:before"));
  assert.ok(proof.events.includes("repair-version:accepted-Api:after"));
  assert.equal(proof.receipts.at(-1)?.phase, "complete");
});

test("a version-only upload can move the settings view before Api activation without changing its serving baseline", async () => {
  const proof = fixture({ placementRepair: true, latestSettings: true });
  await Effect.runPromise(proof.effect);
  const uploaded = proof.events.indexOf("repair-upload:POST:versions");
  const settings = proof.events.indexOf("repair-settings:before", uploaded + 1);
  const activated = proof.events.indexOf("activate:Api:accepted-Api");
  assert.ok(uploaded >= 0 && settings > uploaded && activated > settings);
  assert.equal(proof.receipts.at(-1)?.phase, "complete");
});

test("an unserved candidate left by the previous refusal does not become the next repair baseline", async () => {
  const proof = fixture({ placementRepair: true, latestSettings: true, previousUpload: true });
  await Effect.runPromise(proof.effect);
  assert.ok(proof.events.includes("repair-version:f53d98f3-538d-4d49-ba2e-896b765de46d:before"));
  assert.equal(proof.receipts.at(-1)?.phase, "complete");
});

test("latest-upload repair settings cannot hide script-level drift before activation", async () => {
  const proof = fixture({ placementRepair: true, latestSettings: true, settingsDrift: true });
  await assert.rejects(Effect.runPromise(proof.effect), /script-tags-drift/);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
  assert.ok(!proof.events.some((event) => event.startsWith("activate:")));
});

test("a changed serving deployment refuses even when its latest-upload settings match the repair", async () => {
  const proof = fixture({ placementRepair: true, latestSettings: true, deploymentDrift: true });
  await assert.rejects(Effect.runPromise(proof.effect), /placement-repair-deployment-drift/);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
});
