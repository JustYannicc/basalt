import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { readPatchManifest } from "./releases/patches.ts";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("pool carries bind the exact source, patch bytes and manual retirement proof", () => {
  const registry = readPatchManifest(fileURLToPath(root));
  assert.ok(registry.pool_carries);
  const bytes = read(registry.pool_carries.manifest);
  assert.equal(digest(bytes), registry.pool_carries.content_sha256);
  const sources = JSON.parse(bytes.toString());
  const releases = JSON.parse(read("containers/pool/releases.json").toString());
  const files: string[] = [];
  for (const name of ["home", "node"]) {
    const artifact = sources.artifacts[name],
      release = releases.artifacts[name];
    assert.equal(artifact.commit, release.commit);
    assert.equal(artifact.repository, release.repository);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    for (const patch of artifact.patches) {
      assert.match(patch.identity, /^[a-z][a-z0-9-]+$/);
      assert.match(patch.file, /^[a-zA-Z0-9_.-]+\.patch$/);
      assert.equal(digest(read(`containers/pool/patches/${patch.file}`)), patch.sha256);
      assert.equal(patch.retirement.mode, "manual");
      if (patch.identity === "cliproxy-home-single-line-log-records") {
        assert.equal(name, "home");
        assert.match(
          patch.retirement.requires,
          /escapes embedded CR and LF after formatting all log fields/,
        );
        assert.match(patch.retirement.requires, /exactly one physical line per record/);
        assert.match(
          patch.retirement.requires,
          /formatter and real-child snapshot\/exit-receipt injection regressions/,
        );
        assert.match(patch.retirement.requires, /without changing request handling/);
      } else if (patch.identity === "cliproxy-home-conditional-deletion") {
        assert.equal(name, "home");
        assert.match(
          patch.retirement.requires,
          /conditional credential and membership deletion routes/,
        );
        assert.match(
          patch.retirement.requires,
          /approved PostgreSQL full-row checksum under the mutation lock/,
        );
        assert.match(patch.retirement.requires, /refuse stale rows without deletion/);
        assert.match(
          patch.retirement.requires,
          /refresh-race and unchanged-row deletion regressions/,
        );
      } else if (patch.identity === "cliproxy-home-bounded-db-pool") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0284-home-db-pool.patch");
        assert.match(patch.retirement.requires, /validated connection limits/);
        assert.match(patch.retirement.requires, /config apply and liveness/);
        assert.match(patch.retirement.requires, /direct transport and advisory locks/);
        assert.match(patch.retirement.requires, /pool wait counters/);
      } else if (patch.identity === "cliproxy-home-transaction-schema-owner") {
        assert.equal(name, "home");
        assert.match(patch.retirement.requires, /stable schema owner/);
        assert.match(patch.retirement.requires, /commit and rollback/);
        assert.match(patch.retirement.requires, /multi-process shared-budget/);
      } else if (patch.identity === "cliproxy-home-quota-collection-signals") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0459-home-quota-collection-signals.patch");
        assert.match(patch.retirement.requires, /one bounded metadata-only record/);
        assert.match(
          patch.retirement.requires,
          /returned vendor window field paths and durations before parsing/,
        );
        assert.match(patch.retirement.requires, /actual collector, omitted and unusable window/);
        assert.match(patch.retirement.requires, /real-child container stdout/);
      } else if (patch.identity === "cliproxy-home-xai-device") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0399-home-xai-device.patch");
        assert.match(patch.retirement.requires, /xAI device authorization/);
        assert.match(patch.retirement.requires, /keeps device secrets server-side/);
        assert.match(patch.retirement.requires, /provider expiry and cancellation/);
        assert.match(patch.retirement.requires, /atomic exact-ID completion receipt/);
        assert.match(
          patch.retirement.requires,
          /expiry, denial, pending, slow-down and cancellation regressions/,
        );
      } else {
        assert.ok(
          patch.retirement.requires.includes("forced failure") &&
            patch.retirement.requires.includes("purge"),
        );
      }
      files.push(patch.file);
    }
  }
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(
    files.sort(),
    readdirSync(new URL("containers/pool/patches/", root))
      .filter((file) => file.endsWith(".patch"))
      .sort(),
  );
});
