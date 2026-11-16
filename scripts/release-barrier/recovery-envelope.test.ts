import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseEvidence } from "./evidence.ts";
import { openRecovery, sealRecovery } from "./recovery-envelope.ts";
import { containerRelease } from "./test/container-fixture.ts";
import { manifestDigest } from "./manifest.ts";

test("retained recovery ciphertext binds the candidate, complete manifest and deployment key", () => {
  const candidate = "a".repeat(40),
    fingerprint = "b".repeat(64),
    key = "c".repeat(64);
  const payload = { privateConfiguration: "private-saved-value" };
  const sealed = sealRecovery(payload, key, candidate, fingerprint);
  assert.ok(!JSON.stringify(sealed).includes("private-saved-value"));
  assert.deepEqual(openRecovery(sealed, key, candidate, fingerprint), payload);
  for (const [decryptKey, sha, manifest] of [
    ["d".repeat(64), candidate, fingerprint],
    [key, "e".repeat(40), fingerprint],
    [key, candidate, "f".repeat(64)],
  ])
    assert.throws(
      () => openRecovery(sealed, decryptKey!, sha!, manifest!),
      /authentication-failed/,
    );
  assert.throws(
    () =>
      openRecovery(
        { ...sealed, ciphertext: sealed.ciphertext.slice(1) },
        key,
        candidate,
        fingerprint,
      ),
    /authentication-failed/,
  );
});

test("a real-sized Worker recovery capsule uses the bounded module envelope in both directions", () => {
  const payload = { modules: [{ contentBase64: "x".repeat(2 * 1024 * 1024) }] };
  const candidate = "a".repeat(40),
    fingerprint = "b".repeat(64),
    key = "c".repeat(64);
  assert.throws(() => sealRecovery(payload, key, candidate, fingerprint), /manifest-too-large/);
  const sealed = sealRecovery(payload, key, candidate, fingerprint, "worker-modules");
  assert.deepEqual(openRecovery(sealed, key, candidate, fingerprint, "worker-modules"), payload);
  assert.throws(() => openRecovery(sealed, key, candidate, fingerprint), /authentication-failed/);
});

test("existing CI receipt artifacts retain the exact encrypted configuration without raw secrets", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "container-recovery-evidence-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const proof = containerRelease();
  Object.assign(proof.frozen.baseline.configuration, {
    environmentVariables: [{ name: "PRIVATE", value: "private-saved-value" }],
  });
  const evidence = releaseEvidence(
    join(root, "release-barrier"),
    proof.manifest.candidate,
    "c".repeat(64),
  );
  await evidence.manifest(proof.manifest);
  const retained = JSON.parse(
    await readFile(join(root, "release-barrier", "container-recovery.sealed.json"), "utf8"),
  );
  const opened = openRecovery(
    retained,
    "c".repeat(64),
    proof.manifest.candidate,
    manifestDigest(proof.manifest),
  );
  assert.equal(JSON.stringify(opened).includes("private-saved-value"), true);
  for (const name of await readdir(join(root, "release-barrier")))
    assert.ok(
      !(await readFile(join(root, "release-barrier", name), "utf8")).includes(
        "private-saved-value",
      ),
    );
});
