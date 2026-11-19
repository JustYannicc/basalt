import assert from "node:assert/strict";
import { test } from "node:test";
import { commitOf, parseManifest, vendorChanges, vendorPolicy, vendorProblems } from "./vendor.ts";

test("only the recorded upstream copy of a vendored file passes, and changes are listed", () => {
  const manifest = new Map([
    ["scripts/owned-lint/vendor/a.ts", "1"],
    ["scripts/owned-lint/vendor/b.ts", "2"],
  ]);
  const onDisk = new Map([
    ["scripts/owned-lint/vendor/a.ts", "1"],
    ["scripts/owned-lint/vendor/b.ts", "edited"],
  ]);
  const problems = vendorProblems(manifest, (file) => onDisk.get(file));
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^scripts\/owned-lint\/vendor\/b\.ts is not the upstream copy/u);
  assert.match(vendorProblems(manifest, () => undefined)[0]!, /vendor\/a\.ts is not the upstream/u);
  const outside = new Map([["src/pool/x.ts", "1"]]);
  assert.match(
    vendorProblems(outside, () => "1")[0]!,
    /records src\/pool\/x\.ts, which is outside/u,
  );
  const base = new Map([
    ["scripts/owned-lint/vendor/a.ts", "1"],
    ["scripts/owned-lint/vendor/gone.ts", "3"],
  ]);
  assert.deepEqual(vendorChanges(onDisk, base), [
    "added 1: scripts/owned-lint/vendor/b.ts",
    "removed 1: scripts/owned-lint/vendor/gone.ts",
  ]);
  assert.deepEqual(vendorChanges(onDisk, manifest), ["changed 1: scripts/owned-lint/vendor/b.ts"]);
});

test("a manifest entry that is not a hash is kept, so the integrity check reports it", () => {
  const manifest = parseManifest('{"scripts/owned-lint/vendor/a.ts": 7}');
  assert.match(vendorProblems(manifest, () => "1")[0]!, /vendor\/a\.ts is not the upstream copy/u);
  assert.equal(parseManifest(undefined).size, 0);
});

test("vendored code changes only with a new upstream commit, which is listed for review", () => {
  const [old, next] = ["a".repeat(40), "b".repeat(40)];
  assert.equal(commitOf(`# provenance\n\n- Commit: \`${old}\` (2026-10-13)\n`), old);
  assert.equal(commitOf("- Commit: not a hash\n"), undefined);
  const base = { manifest: new Map([["scripts/owned-lint/vendor/rule.ts", "1"]]), commit: old };
  // A neutered rule and a Basalt file hidden as vendored code, both recorded with --write-vendor.
  const manifest = new Map([
    ["scripts/owned-lint/vendor/rule.ts", "edited"],
    ["scripts/owned-lint/vendor/helper.ts", "2"],
  ]);
  for (const commit of [undefined, old])
    assert.match(
      vendorPolicy({ manifest, commit }, base).problems.join("\n"),
      /Vendored code changed without an upstream update \(added 1: scripts\/owned-lint\/vendor\/helper\.ts; changed 1: scripts\/owned-lint\/vendor\/rule\.ts\)/u,
      String(commit),
    );
  const update = vendorPolicy({ manifest, commit: next }, base);
  assert.deepEqual(update.problems, []);
  assert.match(
    update.notices.join("\n"),
    new RegExp(
      `Vendored anti-slop updated ${old} -> ${next}; review the copy against that upstream commit: added 1: scripts/owned-lint/vendor/helper\\.ts; changed 1`,
      "u",
    ),
  );
  assert.deepEqual(vendorPolicy({ manifest: base.manifest, commit: old }, base), {
    problems: [],
    notices: [],
  });
});
