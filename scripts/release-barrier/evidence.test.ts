import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerPublication } from "./test/container-fixture.ts";
import { describeContainer } from "./container.ts";
import { releaseEvidence } from "./evidence.ts";
import { BarrierRefusal, manifestDigest, type ReleaseManifest } from "./manifest.ts";

const candidate = "a".repeat(40);
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
