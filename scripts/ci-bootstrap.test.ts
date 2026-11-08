import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { actionlintSource } from "./ci/actionlint.ts";
import { downloadVerified } from "./ci/verified-download.ts";

test("verified cache hits make no request, and corrupt archives fail before use", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-archive-cache-"));
  try {
    const archive = join(root, "archive");
    writeFileSync(archive, "fixture bytes");
    const integrity = "sha256-" + createHash("sha256").update("fixture bytes").digest("base64");
    downloadVerified("https://release-assets-blocked.invalid/archive", integrity, archive);
    writeFileSync(archive, "corrupted");
    assert.throws(
      () => downloadVerified("https://release-assets-blocked.invalid/archive", integrity, archive),
      /checksum mismatch/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actionlint cold population uses pinned Go source and fast requires the warmed cache", () => {
  assert.equal(new URL(actionlintSource.url).host, "proxy.golang.org");
  assert.match(actionlintSource.sha256, /^[a-f0-9]{64}$/);
  const launcher = readFileSync(new URL("./ci/check-workflows.ts", import.meta.url), "utf8");
  assert.doesNotMatch(launcher, /github\.com.*releases\/download/);
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const action = "./.github/actions/setup-actionlint";
  assert.ok(workflow.jobs.select.steps.some((step: { uses?: string }) => step.uses === action));
  assert.equal(
    workflow.jobs.fast.steps.find((step: { uses?: string }) => step.uses === action).with[
      "require-hit"
    ],
    "true",
  );
  assert.equal(workflow.jobs.fast.needs, "select");
});
