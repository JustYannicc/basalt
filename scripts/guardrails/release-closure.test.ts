import assert from "node:assert/strict";
import { matchesGlob } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { carriesReaching, patchTargets, releaseClosure } from "./release-closure.ts";
import { laneModules, onReleasePath, releaseCuts, releaseDecided } from "./release-path.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const closure = releaseClosure(root);
const decided = (file: string) => releaseDecided.some(({ path }) => matchesGlob(file, path));
const shown = (file: string) => closure.chain(file).join(" -> ");

test("every file a production release runs is on the release path or decided with a reason", () => {
  const unlisted = closure.files.filter((file) => !onReleasePath(file) && !decided(file));
  assert.deepEqual(
    unlisted.map(shown),
    [],
    "Add each file to release-path.json: to `paths` if a change to it changes how a release is made, else to `decided` with why it is not.",
  );
  assert.ok(closure.entries.includes("scripts/release/deploy.ts"), closure.entries.join(", "));
});

test("every cut and every decision still names something the release reaches", () => {
  const unusedCuts = releaseCuts.filter(
    ({ path }) => !closure.cuts.some((file) => matchesGlob(file, path)),
  );
  const unusedDecisions = releaseDecided.filter(
    ({ path }) => !closure.files.some((file) => matchesGlob(file, path)),
  );
  assert.deepEqual(
    [...unusedCuts, ...unusedDecisions].map(({ path }) => path),
    [],
  );
  for (const { path, why } of [...releaseCuts, ...releaseDecided]) assert.ok(why.trim(), path);
});

test("the lane's modules are exactly the decided pool modules a release script imports directly", () => {
  const direct = new Set<string>();
  for (const [importer, targets] of closure.imports)
    if (importer.startsWith("scripts/") && onReleasePath(importer))
      for (const target of targets)
        if (target.startsWith("src/pool/") && closure.files.includes(target) && decided(target))
          direct.add(target);
  assert.deepEqual([...laneModules].sort(), [...direct].sort());
});

test("every carry that patches an upstream file the release reaches is on the release path", () => {
  const unlisted = carriesReaching(root, closure.upstream, closure.tracked).filter(
    ({ carry }) => !onReleasePath(carry),
  );
  assert.deepEqual(
    unlisted.map(({ carry, targets }) => `${carry} patches ${targets.join(", ")}`),
    [],
  );
});

test("a carry's targets are read from its git headers only", () => {
  const patch = [
    "diff --git a/apps/one.ts b/apps/one.ts",
    "--- a/apps/one.ts",
    "+++ b/apps/one.ts",
    "@@ -1 +1 @@",
    "--- a/not-a-header.ts",
    "+x",
  ].join("\n");
  assert.deepEqual(patchTargets(patch), ["apps/one.ts"]);
});
