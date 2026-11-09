import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { classProvisioning } from "./test/declared-class-fixture.ts";
import { classEvidence } from "./class-evidence.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { canonical, digest } from "./manifest.ts";

test("class evidence names the exact inactive clone and separates live expansion from refused activation while encrypting recoverable bytes", async () => {
  const proof = classProvisioning({ reject: true });
  await Effect.runPromise(proof.effect);
  const files = new Map<string, unknown>();
  const candidate = "a".repeat(40);
  const key = "b".repeat(64);
  const evidence = classEvidence(
    async (name, value) => {
      files.set(name, value);
    },
    candidate,
    key,
  );
  for (const progress of proof.progress) await evidence.expansion(progress);
  const publicEvidence = JSON.stringify(files.get("class-expansion.json"));
  assert.ok(publicEvidence.includes('"versionId":"baseline-clone"'));
  assert.ok(publicEvidence.includes('"status":"removed"'));
  assert.ok(publicEvidence.includes('"expansionVersion":"expanded"'));
  assert.ok(publicEvidence.includes('"liveDeploymentAttempted":true'));
  assert.ok(!publicEvidence.includes("export default"));
  assert.ok(!publicEvidence.includes("compatibilityDate"));
  assert.ok(!publicEvidence.includes("fixture-appdata"));
  assert.ok(evidence.summary().includes("baseline-clone"));
  assert.ok(evidence.summary().includes("post-deployment"));
  const manifest = digest(canonical({ purpose: "declared-class-expansion", candidate }));
  const recovered = openRecovery(
    files.get("class-recovery.sealed.json"),
    key,
    candidate,
    manifest,
    "worker-modules",
  );
  const text = JSON.stringify(recovered);
  assert.ok(text.includes('"versionId":"baseline-clone"'));
  assert.ok(text.includes('"deploy":false'));
  assert.ok(text.includes('"bindingsInherit":"strict"'));
  assert.ok(
    text.includes(
      Buffer.from("export default { fetch() { return new Response('baseline'); } };\n").toString(
        "base64",
      ),
    ),
  );
  assert.throws(
    () =>
      openRecovery(
        files.get("class-recovery.sealed.json"),
        "c".repeat(64),
        candidate,
        manifest,
        "worker-modules",
      ),
    /authentication-failed/,
  );
});

test("an invalid encryption key refuses before publishing a class operation intent", async () => {
  const proof = classProvisioning();
  await Effect.runPromise(proof.effect);
  const writes: string[] = [];
  const evidence = classEvidence(
    async (name) => {
      writes.push(name);
    },
    "a".repeat(40),
    "invalid",
  );
  await assert.rejects(evidence.expansion(proof.progress[0]!), /key-invalid/);
  assert.deepEqual(writes, []);
});

test("class recovery retains modules larger than the configuration envelope without widening its default limit", async () => {
  const proof = classProvisioning();
  await Effect.runPromise(proof.effect);
  const progress = proof.progress[0]!;
  const candidate = "a".repeat(40),
    key = "b".repeat(64);
  const files = new Map<string, unknown>();
  const evidence = classEvidence(
    async (name, value) => {
      files.set(name, value);
    },
    candidate,
    key,
  );
  const source = "x".repeat(1_100_000);
  await evidence.expansion({
    ...progress,
    request: {
      ...progress.request,
      files: [new File([source], "main.js", { type: "application/javascript+module" })],
    },
  });
  const manifest = digest(canonical({ purpose: "declared-class-expansion", candidate }));
  assert.throws(
    () => openRecovery(files.get("class-recovery.sealed.json"), key, candidate, manifest),
    /authentication-failed/,
  );
  const value = openRecovery(
    files.get("class-recovery.sealed.json"),
    key,
    candidate,
    manifest,
    "worker-modules",
  );
  assert.ok(JSON.stringify(value).includes(Buffer.from(source).toString("base64")));
});
