import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateTreeEnvironment,
  candidateTreeKeys,
  overlayExtent,
  restartExpectArgs,
} from "./stage.ts";

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

test("a candidate tree releases on its own pin, served version and framework build", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-trees-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd,
      encoding: "utf8",
    }).trim();
  const served = (version: string) => `export const servedFrameworkVersion = "${version}";\n`;
  const build = (version: string) =>
    JSON.stringify({
      "package.json": JSON.stringify({ name: "apps", version }),
      "runtime.json": JSON.stringify({ protocol: 1, version }),
    });
  /** A prepared candidate: its own repository, with `.upstream` its own checkout at `upstream.json`. */
  const tree = async (name: string, version: string) => {
    const dir = join(at, name);
    const upstream = join(dir, ".upstream");
    await mkdir(join(upstream, ".local/basalt-framework"), { recursive: true });
    git(upstream, "init", "-q");
    git(upstream, "commit", "-q", "--allow-empty", "-m", `upstream for ${name}`);
    const commit = git(upstream, "rev-parse", "HEAD");
    await writeFile(join(dir, "upstream.json"), JSON.stringify({ commit }));
    await writeFile(join(dir, "framework-release.ts"), served(version));
    await writeFile(join(upstream, ".local/basalt-framework/framework.json"), build(version));
    git(dir, "init", "-q");
    git(dir, "add", "upstream.json", "framework-release.ts");
    git(dir, "commit", "-q", "-m", "candidate");
    return { dir, upstream, commit };
  };
  const harness = await tree("harness", "1");
  const candidate = await tree("candidate", "2");
  assert.notEqual(candidate.commit, harness.commit);

  assert.deepEqual(candidateTreeEnvironment(harness.dir, harness.dir), {});
  const env = candidateTreeEnvironment(harness.dir, candidate.dir);
  assert.deepEqual(env, {
    EXECUTOR_BUILD_VERSION: candidate.commit,
    EXECUTOR_APPS_VERSION: "2",
    EXECUTOR_APPS_FRAMEWORK: join(candidate.upstream, ".local/basalt-framework"),
  });
  // A fixed set: nothing naming the stage, its database or its origin.
  assert.deepEqual(Object.keys(env).sort(), [...candidateTreeKeys].sort());

  const refused = (pattern: RegExp, why: string) =>
    assert.throws(() => candidateTreeEnvironment(harness.dir, candidate.dir), pattern, why);
  const pinFile = join(candidate.dir, "upstream.json");
  const releaseFile = join(candidate.dir, "framework-release.ts");
  const frameworkFile = join(candidate.upstream, ".local/basalt-framework/framework.json");

  // 1. upstream.json missing, malformed, or without a 40-hex commit.
  for (const body of [
    undefined,
    "{",
    JSON.stringify({}),
    JSON.stringify({ commit: "main" }),
    JSON.stringify({ commit: candidate.commit.toUpperCase() }),
  ]) {
    await rm(pinFile, { force: true });
    if (body !== undefined) await writeFile(pinFile, body);
    refused(/names no upstream commit/u, String(body));
  }

  // 2. The prepared checkout is not at the pin: another commit, or no checkout of its own.
  await writeFile(pinFile, JSON.stringify({ commit: harness.commit }));
  refused(/upstream checkout off its own pin/u, "foreign pin");
  await writeFile(pinFile, JSON.stringify({ commit: candidate.commit }));
  git(candidate.upstream, "commit", "-q", "--allow-empty", "-m", "moved");
  refused(/upstream checkout off its own pin/u, "checkout moved");
  git(candidate.upstream, "reset", "-q", "--hard", candidate.commit);
  await rm(join(candidate.upstream, ".git"), { recursive: true, force: true });
  refused(/no prepared upstream checkout/u, "a plain directory in the candidate's repository");
  git(candidate.upstream, "init", "-q");
  git(candidate.upstream, "commit", "-q", "--allow-empty", "-m", "upstream");
  const rebuilt = git(candidate.upstream, "rev-parse", "HEAD");
  await writeFile(pinFile, JSON.stringify({ commit: rebuilt }));
  assert.equal(
    candidateTreeEnvironment(harness.dir, candidate.dir).EXECUTOR_BUILD_VERSION,
    rebuilt,
  );

  // 3. The framework build is missing, or records another version.
  await rm(frameworkFile);
  refused(/no framework build/u, "missing build");
  await writeFile(frameworkFile, "not json");
  refused(/no framework build/u, "unreadable build");
  await writeFile(frameworkFile, build("1"));
  refused(/framework build of another version/u, "harness's build");
  await writeFile(
    frameworkFile,
    JSON.stringify({ ...JSON.parse(build("2")), "runtime.json": JSON.stringify({ version: "1" }) }),
  );
  refused(/framework build of another version/u, "mixed build");
  await writeFile(frameworkFile, build("2"));

  // 4. framework-release.ts is missing or yields no literal version.
  for (const body of [
    undefined,
    "",
    "export const servedFrameworkVersion = version;\n",
    `${served("2")}${served("3")}`,
  ]) {
    await rm(releaseFile, { force: true });
    if (body !== undefined) await writeFile(releaseFile, body);
    refused(/serves no framework version/u, String(body));
  }
  await writeFile(releaseFile, served("2"));
  assert.equal(candidateTreeEnvironment(harness.dir, candidate.dir).EXECUTOR_APPS_VERSION, "2");
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

test("a release run takes only a rehearse/ branch and a named policy from its candidate file", async () => {
  const { releaseCandidate } = await import("./stage.ts");
  assert.deepEqual(
    releaseCandidate(JSON.stringify({ branch: "rehearse/release-a-1601", policy: "code" })),
    { branch: "rehearse/release-a-1601", policy: "code" },
  );
  for (const spec of [
    { branch: "", policy: "code" },
    { branch: "main", policy: "code" },
    { branch: "rehearse/x; rm -rf /", policy: "code" },
    { branch: "rehearse/release-a", policy: "" },
    { branch: "rehearse/release-a", policy: "../../etc/passwd" },
    { branch: "rehearse/production-PLACEHOLDER", policy: "release" },
  ])
    assert.throws(() => releaseCandidate(JSON.stringify(spec)), /names no/u, JSON.stringify(spec));
  // The committed file names a placeholder branch until a run is set up; no such branch exists.
  const { readFileSync } = await import("node:fs");
  assert.deepEqual(
    releaseCandidate(readFileSync(new URL("./release-candidate.json", import.meta.url), "utf8")),
    { branch: "rehearse/production-placeholder", policy: "release" },
  );
});
