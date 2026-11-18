import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkpoint, manifestPath, previewNumber } from "./checkpoint.ts";

test("the close job can recover an authenticated private checkpoint without uploading plaintext", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-checkpoint-")),
    key = "ab".repeat(32);
  const path = manifestPath(root, 17),
    encrypted = join(root, "checkpoint.json.enc");
  try {
    await mkdir(dirname(path), { recursive: true });
    const value = { version: 1, pullRequest: 17, stage: "test-pr-17", opaque: "private-fixture" };
    await writeFile(path, JSON.stringify(value));
    await checkpoint("seal", root, encrypted, key, 17);
    assert.ok(!(await readFile(encrypted, "utf8")).includes("private-fixture"));
    await rm(path);
    await checkpoint("restore", root, encrypted, key, 17);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), value);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(checkpoint("restore", root, encrypted, key, 17), /EEXIST/);
    await assert.rejects(checkpoint("restore", root, encrypted, key, 18), /authentication failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preview numbers cannot become paths or option arguments", () => {
  assert.equal(previewNumber("17"), 17);
  for (const value of [
    "0",
    "-1",
    "../17",
    "17/path",
    "17.5",
    "--bad",
    "9007199254740992",
    undefined,
  ]) {
    assert.throws(() => previewNumber(value));
  }
});

test("a rehearsal checkpoint lives beside a PR's and neither restores as the other", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-checkpoint-")),
    key = "ab".repeat(32);
  const rehearsal = { kind: "rehearsal", number: 17 } as const;
  const path = manifestPath(root, rehearsal),
    encrypted = join(root, "rehearsal.json.enc");
  const prEncrypted = join(root, "pr.json.enc");
  try {
    assert.equal(path, join(root, ".local", "previews", "rehearsal-17.json"));
    assert.notEqual(path, manifestPath(root, 17));
    await mkdir(dirname(path), { recursive: true });
    const value = { version: 1, rehearsal: 17, stage: "test-rehearsal-17" };
    await writeFile(path, JSON.stringify(value));
    await writeFile(
      manifestPath(root, 17),
      JSON.stringify({ version: 1, pullRequest: 17, stage: "test-pr-17" }),
    );
    await checkpoint("seal", root, encrypted, key, rehearsal);
    await checkpoint("seal", root, prEncrypted, key, 17);
    await rm(path);
    await rm(manifestPath(root, 17));
    await assert.rejects(checkpoint("restore", root, encrypted, key, 17), /authentication failed/);
    await assert.rejects(
      checkpoint("restore", root, prEncrypted, key, rehearsal),
      /authentication failed/,
    );
    await checkpoint("restore", root, encrypted, key, rehearsal);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rehearsal checkpoint refuses a plaintext that names a PR", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-checkpoint-owner-")),
    key = "ab".repeat(32);
  const rehearsal = { kind: "rehearsal", number: 17 } as const;
  const encrypted = join(root, "rehearsal.json.enc");
  try {
    await mkdir(dirname(manifestPath(root, rehearsal)), { recursive: true });
    await writeFile(
      manifestPath(root, rehearsal),
      JSON.stringify({ version: 1, rehearsal: 17, pullRequest: 17 }),
    );
    await checkpoint("seal", root, encrypted, key, rehearsal);
    await rm(manifestPath(root, rehearsal));
    await assert.rejects(
      checkpoint("restore", root, encrypted, key, rehearsal),
      /different rehearsal/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
