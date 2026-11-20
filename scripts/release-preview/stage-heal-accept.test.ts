import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateTreeEnvironment, overlayExtent, restartExpectArgs } from "./stage.ts";

const older =
  'if [ -n "$within" ]; then expect=(--expect restart --root-boot .local/release/root-boot.json --serving .local/release/serving.json --within "$within"); fi';
const newer =
  'if [ -n "$within" ]; then expect=(--expect restart --serving .local/release/serving.json --apply "${{ steps.apply.outcome }}"); fi';

test("restartExpectArgs follows the candidate's own release.yml form", () => {
  assert.deepEqual(
    restartExpectArgs({ workflow: older, bound: 420, serving: "/o/s.json", apply: "failure" }),
    ["--expect", "restart", "--serving", "/o/s.json", "--within", "420"],
  );
  assert.deepEqual(
    restartExpectArgs({ workflow: newer, bound: 420, serving: "/o/s.json", apply: "failure" }),
    ["--expect", "restart", "--serving", "/o/s.json", "--apply", "failure"],
  );
});

test("restartExpectArgs refuses a workflow with no restart acceptance, or a missing bound", () => {
  assert.throws(
    () => restartExpectArgs({ workflow: "run: true", bound: 420, serving: "s", apply: "success" }),
    /no root restart acceptance/u,
  );
  assert.throws(
    () => restartExpectArgs({ workflow: older, bound: undefined, serving: "s", apply: "success" }),
    /no restart bound/u,
  );
});

test("a candidate tree uploads its own built framework, and only on the harness's upstream pin", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-trees-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const tree = async (name: string, commit: string) => {
    const dir = join(at, name);
    await mkdir(dir);
    await writeFile(join(dir, "upstream.json"), JSON.stringify({ commit }));
    await writeFile(
      join(dir, "framework-release.ts"),
      'export const servedFrameworkVersion = "1";\n',
    );
    return dir;
  };
  const harness = await tree("harness", "a".repeat(40));
  const same = await tree("same", "a".repeat(40));
  const other = await tree("other", "b".repeat(40));
  assert.deepEqual(candidateTreeEnvironment(harness, harness), {});
  assert.deepEqual(candidateTreeEnvironment(harness, same), {
    EXECUTOR_APPS_FRAMEWORK: join(same, ".upstream/.local/basalt-framework"),
  });
  assert.throws(() => candidateTreeEnvironment(harness, other), /another upstream commit/u);
  await writeFile(
    join(same, "framework-release.ts"),
    'export const servedFrameworkVersion = "2";\n',
  );
  assert.throws(() => candidateTreeEnvironment(harness, same), /another framework version/u);
});

test("a heal record measures the stage-only overlay back to the first unmarked commit", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "stage-overlay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git("init", "-q");
  const commit = async (file: string, body: string, message: string) => {
    await writeFile(join(dir, file), body);
    git("add", file);
    git("commit", "-q", "-m", message);
  };
  await commit("a.ts", "one\n", "feat: the trial");
  await commit("b.ts", "two\nthree\n", "STAGE-ONLY OVERLAY: a trigger");
  await commit("a.ts", "one\nfour\n", "rehearsal: a binding");
  const extent = overlayExtent(dir);
  assert.equal(extent.commits.length, 2);
  assert.match(extent.commits[0]!, /rehearsal: a binding$/u);
  assert.deepEqual(extent.files.map((file) => [file.path, file.added, file.removed]).sort(), [
    ["a.ts", 1, 0],
    ["b.ts", 2, 0],
  ]);
  assert.equal(extent.added, 3);
});
