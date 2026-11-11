import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerPublication } from "./test/container-fixture.ts";
import { describeContainer, stageContainer } from "./container.ts";
import { containerProps } from "./test/container-fixture.ts";
import { Effect } from "effect";
import { releaseEvidence } from "./evidence.ts";
import { releaseWorkers } from "./barrier.ts";
import { reportRefusal } from "./refusal-report.ts";
import { BarrierRefusal, manifestDigest, type ReleaseManifest } from "./manifest.ts";

const candidate = "a".repeat(40);

test("a startup-headroom refusal retains both measurements in receipt and failure files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "startup-remeasurement-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const evidence = releaseEvidence(root, candidate);
  const manifest: ReleaseManifest = {
    candidate,
    stack: "fixture",
    stage: "production",
    workers: [
      {
        id: "AppPages",
        accountId: "fixture",
        scriptName: "app-pages",
        metadata: { mainModule: "main.js" },
        files: [
          {
            name: "main.js",
            type: "application/javascript+module",
            bytes: new TextEncoder().encode("export default {}"),
          },
        ],
        baseline: [{ versionId: "old", percentage: 100 }],
      },
    ],
  };
  let uploads = 0;
  const error = await releaseWorkers(manifest, {
    record: evidence.record,
    provider: {
      async upload() {
        uploads++;
        return { versionId: `version-${uploads}`, startupTimeMs: uploads === 1 ? 770 : 780 };
      },
      async baseline() {
        assert.fail("refused uploads must not read activation baselines");
      },
      async activate() {
        assert.fail("refused uploads must not activate");
      },
    },
  }).then(
    () => assert.fail("expected startup refusal"),
    (error) => error,
  );
  await evidence.failure(error);
  const receipt = JSON.parse(await readFile(join(root, "receipt.json"), "utf8"));
  const failure = JSON.parse(await readFile(join(root, "failure.json"), "utf8"));
  const measurements = [
    { worker: "AppPages", versionId: "version-1", startupTimeMs: 770 },
    { worker: "AppPages", versionId: "version-2", startupTimeMs: 780 },
  ];
  assert.equal(uploads, 2);
  assert.deepEqual(receipt.startupMeasurements, measurements);
  assert.deepEqual(failure.startupMeasurements, measurements);
  assert.deepEqual(failure.activated, []);
  assert.equal(failure.reason, "startup-headroom");
  const output: string[] = [];
  const summary = join(root, "summary.md");
  await reportRefusal(failure, summary, (message) => output.push(message));
  for (const text of [output.join("\n"), await readFile(summary, "utf8")]) {
    assert.match(text, /AppPages/);
    assert.match(text, /770 → 780; ceiling=750 ms/);
  }
});
test("exact frozen requests stay private while refusal receipts retain the safe disposition", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const safe = join(root, "release-barrier");
  const evidence = releaseEvidence(safe, candidate);
  await evidence.failure(new BarrierRefusal("new-or-unsettled-resource", "NewWorker"));
  const preflight = JSON.parse(await readFile(join(safe, "failure.json"), "utf8"));
  assert.deepEqual(preflight, {
    schemaVersion: 1,
    candidate,
    phase: "preparation",
    ceilingMs: 750,
    manifest: null,
    activated: [],
    reason: "new-or-unsettled-resource",
    worker: "NewWorker",
  });
  const manifest: ReleaseManifest = {
    candidate,
    stack: "fixture",
    stage: "production",
    workers: [
      {
        id: "Api",
        accountId: "fixture",
        scriptName: "api",
        metadata: {
          mainModule: "main.js",
          bindings: [{ type: "secret_text", name: "PRIVATE", text: "private-binding-value" }],
        },
        files: [
          {
            name: "main.js",
            type: "application/javascript+module",
            bytes: new TextEncoder().encode("exact-module-bytes"),
          },
        ],
        baseline: [{ versionId: "old", percentage: 100 }],
      },
    ],
  };
  await evidence.manifest(manifest);
  const privateFile = join(root, "release-barrier-private", "frozen.json");
  const frozen = JSON.parse(await readFile(privateFile, "utf8"));
  assert.equal(frozen.workers[0].metadata.bindings[0].text, "private-binding-value");
  assert.equal(
    Buffer.from(frozen.workers[0].files[0].base64, "base64").toString(),
    "exact-module-bytes",
  );
  assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, "release-barrier-private"))).mode & 0o777, 0o700);
  const receipt = {
    schemaVersion: 1 as const,
    candidate,
    manifest: manifestDigest(manifest),
    ceilingMs: 750,
    phase: "activation" as const,
    accepted: [{ worker: "Api", versionId: "accepted", startupTimeMs: 100 }],
    activated: [],
    pending: { worker: "Api", versionId: "accepted" },
  };
  await evidence.record(receipt);
  await evidence.failure(new BarrierRefusal("activation-unconfirmed", "Api"));
  const failure = JSON.parse(await readFile(join(safe, "failure.json"), "utf8"));
  assert.equal(failure.manifest, receipt.manifest);
  assert.equal(failure.phase, "activation");
  assert.deepEqual(failure.pending, receipt.pending);
  for (const name of await readdir(safe)) {
    const text = await readFile(join(safe, name), "utf8");
    assert.ok(!text.includes("private-binding-value"));
    assert.ok(!text.includes("exact-module-bytes"));
  }
});

test("image progress survives preparation failure without exposing its configuration", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "release-publication-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const evidence = releaseEvidence(root, candidate);
  const proof = containerPublication();
  const frozen = {
    ...proof.frozen,
    configuration: {
      ...proof.frozen.configuration,
      environmentVariables: [{ name: "PRIVATE", value: "private-configuration" }],
    },
  };
  await evidence.publication(frozen);
  await evidence.failure(new BarrierRefusal("preparation-or-provider-failed"));
  const text = await readFile(join(root, "publication.json"), "utf8");
  assert.deepEqual(JSON.parse(text), { candidate, containers: [describeContainer(frozen)] });
  assert.ok(!text.includes("private-configuration"));
  assert.ok(!text.includes("registry.cloudflare.com"));
});

test("baseline observation receipts preserve versions and paths without claiming a native write", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "release-normalization-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const evidence = releaseEvidence(root, candidate);
  const proof = containerPublication();
  const staged = await Effect.runPromise(
    stageContainer(
      { ...proof.publication, previous: { ...proof.previous, version: 2 } },
      containerProps(),
      containerProps(),
      proof.previous,
      () => Effect.succeed(proof.metadata),
    ),
  );
  await evidence.publication(staged.frozen, staged.normalization);
  await evidence.failure(new BarrierRefusal("preparation-or-provider-failed"));
  const text = await readFile(join(root, "publication.json"), "utf8");
  assert.deepEqual(JSON.parse(text).baselineNormalization, {
    disposition: "observed-baseline",
    recordedVersion: 1,
    observedVersion: 2,
    imageDigest: proof.previous.hash!.digest,
    changed: [{ path: "version", old: 1, new: 2 }],
  });
  assert.equal(JSON.parse(text).containers[0].baselineVersion, 2);
  assert.ok(!text.includes("registry.cloudflare.com"));
  assert.equal((await stat(join(root, "publication.json"))).mode & 0o777, 0o600);
});
