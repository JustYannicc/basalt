import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, matchesGlob } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
  carriesReaching,
  patchTargets,
  releaseClosure,
  releaseEntries,
} from "./release-closure.ts";
import { laneModules, onReleasePath, releaseCuts, releaseDecided } from "./release-path.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
let cached: ReturnType<typeof releaseClosure> | undefined;
// Built once, inside a test, so the test runner's deadline bounds the walk.
const closure = () => (cached ??= releaseClosure(root));
const decided = (file: string) => releaseDecided.some(({ path }) => matchesGlob(file, path));
// The decided pool runtime modules: pool Worker code the release's scripts also run.
const poolShared = (file: string) =>
  releaseDecided.some(({ path, pool }) => pool === true && matchesGlob(file, path));

test("every file a production release runs is on the release path or decided with a reason", () => {
  const { files, entries, chain } = closure();
  const unlisted = files.filter((file) => !onReleasePath(file) && !decided(file));
  assert.deepEqual(
    unlisted.map((file) => chain(file).join(" -> ")),
    [],
    "Add each file to release-path.json: to `paths` if a change to it changes how a release is made, else to `decided` with why it is not.",
  );
  for (const entry of ["scripts/release/deploy.ts", "scripts/prepare-upstream.ts"])
    assert.ok(entries.includes(entry), entries.join(", "));
});

test("a Worker entry the release reaches is a cut, so its program is judged by its plan row", () => {
  const { files, chain } = closure();
  assert.deepEqual(
    files
      .filter((file) => /(?:^|[./])worker\.ts$/u.test(file))
      .map((file) => chain(file).join(" -> ")),
    [],
  );
});

test("every cut and every decision still names something the release reaches", () => {
  const { cuts, files, upstream, tracked } = closure();
  const reached = [...files, ...carriesReaching(root, upstream, tracked).map(({ carry }) => carry)];
  const unusedCuts = releaseCuts.filter(
    ({ path }) => !cuts.some((file) => matchesGlob(file, path)),
  );
  const unusedDecisions = releaseDecided.filter(
    ({ path }) => !reached.some((file) => matchesGlob(file, path.replace(/\.\*$/u, ".patch"))),
  );
  assert.deepEqual(
    [...unusedCuts, ...unusedDecisions].map(({ path }) => path),
    [],
  );
  for (const { path, why } of [...releaseCuts, ...releaseDecided]) assert.ok(why.trim(), path);
});

test("the lane's modules are exactly the decided pool modules a release script imports directly", () => {
  const { imports, files } = closure();
  const reached = new Set(files);
  const direct = new Set<string>();
  for (const [importer, targets] of imports)
    if (importer.startsWith("scripts/") && onReleasePath(importer))
      for (const target of targets)
        if (reached.has(target) && poolShared(target)) direct.add(target);
  assert.deepEqual([...laneModules].sort(), [...direct].sort());
});

test("every carry the release depends on is on the release path or decided with a reason", () => {
  const { upstream, tracked } = closure();
  const unlisted = carriesReaching(root, upstream, tracked).filter(
    ({ carry }) => !onReleasePath(carry) && !decided(carry),
  );
  assert.deepEqual(
    unlisted.map(({ carry, targets }) => `${carry} patches ${targets.join(", ")}`),
    [],
  );
});

/** A repository of its own, committed, so the import graph reads it as tracked files. */
function repository(context: TestContext, files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "release-closure-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "fixture");
  return dir;
}

const workflow = [
  "on: push",
  "jobs:",
  "  release:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: ./.github/actions/setup",
  "      - run: npm run build",
  "      - run: node scripts/a.ts",
  "",
].join("\n");

test("entries come through package scripts and local actions, as CI reads a job", (context) => {
  const dir = repository(context, {
    ".github/workflows/release.yml": workflow,
    ".github/actions/setup/action.yml":
      "runs:\n  using: composite\n  steps:\n    - run: node scripts/setup.ts\n      shell: bash\n",
    "package.json": JSON.stringify({ scripts: { build: "node scripts/build.ts" } }),
    "scripts/a.ts": "",
    "scripts/build.ts": "",
    "scripts/setup.ts": "",
  });
  const files = execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.deepEqual([...releaseEntries(dir, files, [".github/workflows/**"])].sort(), [
    "scripts/a.ts",
    "scripts/build.ts",
    "scripts/setup.ts",
  ]);
});

test("the walk stops at a cut, and the cut is reported as reached", (context) => {
  const dir = repository(context, {
    ".github/workflows/release.yml": workflow,
    ".github/actions/setup/action.yml": "runs:\n  using: composite\n  steps: []\n",
    "package.json": JSON.stringify({ scripts: { build: "node scripts/build.ts" } }),
    "scripts/a.ts": 'import "./b.ts";\n',
    "scripts/b.ts": 'import "./c.ts";\n',
    "scripts/c.ts": "",
    "scripts/build.ts": "",
  });
  const walked = releaseClosure(dir, ["scripts/b.ts"]);
  assert.ok(walked.files.includes("scripts/a.ts"), walked.files.join(", "));
  assert.ok(!walked.files.includes("scripts/c.ts"), walked.files.join(", "));
  assert.deepEqual(walked.cuts, ["scripts/b.ts"]);
});

test("a carry's targets are read from its git headers only", () => {
  const patch = [
    "diff --git a/apps/one.ts b/apps/one.ts",
    "--- a/apps/one.ts",
    "+++ b/apps/one.ts",
    "@@ -1 +1 @@",
    "--- a/not-a-header.ts",
    "+diff --git a/nested/inside.ts b/nested/inside.ts",
  ].join("\n");
  assert.deepEqual(patchTargets(patch), ["apps/one.ts"]);
});
