import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateTreeEnvironment,
  laneSubject,
  overlayExtent,
  requireCandidateGuard,
  restartExpectArgs,
  runEntry,
  sameStateDecoder,
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

/**
 * A prepared candidate: its own repository, with `.upstream` its own checkout at `upstream.json`
 * and, unless `built` is false, a framework build of `version`.
 */
async function preparedTree(
  at: string,
  name: string,
  version: string,
  { built = true }: { built?: boolean } = {},
) {
  const dir = join(at, name);
  const upstream = join(dir, ".upstream");
  await mkdir(upstream, { recursive: true });
  git(upstream, "init", "-q");
  git(upstream, "commit", "-q", "--allow-empty", "-m", `upstream for ${name}`);
  const commit = git(upstream, "rev-parse", "HEAD");
  await writeFile(join(dir, "upstream.json"), JSON.stringify({ commit }));
  await writeFile(join(dir, "framework-release.ts"), served(version));
  if (built) {
    await mkdir(join(upstream, ".local/basalt-framework"), { recursive: true });
    await writeFile(join(upstream, ".local/basalt-framework/framework.json"), build(version));
  }
  git(dir, "init", "-q");
  git(dir, "add", "upstream.json", "framework-release.ts");
  git(dir, "commit", "-q", "-m", "candidate");
  return { dir, upstream, commit };
}

/** The stage-identity keys `stageEnvironment` sets: stage, database, origin, State and secrets. */
const stageIdentityKeys = [
  "ALCHEMY_STAGE",
  "CLOUD_SOURCE_NAMESPACE",
  "TEST_STAGE_DOMAIN",
  "TEST_STAGE_EXPIRES_AT",
  "TEST_STAGE_DATABASE",
  "TEST_STAGE_DATABASE_PROVIDER",
  "PLANETSCALE_DATABASE_NAME",
  "PLANETSCALE_ORGANIZATION",
  "PLANETSCALE_API_TOKEN_ID",
  "PLANETSCALE_API_TOKEN",
  "BETTER_AUTH_URL",
  "EXECUTOR_CATALOG_URL",
  "EXECUTOR_TELEMETRY_RELAY_URL",
  "AUTH_EMAIL_DOMAIN",
  "PREVIEW_STATE_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "POOL_DEPLOYMENT_KEY",
  "TELEMETRY_RELAY_KEY",
  "EXECUTOR_TELEMETRY_RELAY_TOKEN",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
  "BETTER_AUTH_SECRET",
  "EXECUTOR_ENCRYPTION_KEY",
  "MCP_SESSION_KEY_CURRENT",
  "MCP_SESSION_KEY_PREVIOUS",
  "APP_DOMAIN_CONTROL_SECRET",
  "POOL_MANAGEMENT_KEY",
  "POOL_APP_SIGNING_KEY",
  "PREVIEW_SMOKE_EMAIL",
  "PREVIEW_SMOKE_PASSWORD",
];

test("a candidate tree releases on its own pin, served version and framework build", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-trees-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const tree = (name: string, version: string) => preparedTree(at, name, version);
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
  // Nothing naming the stage, its database, its origin, its State or its secrets.
  for (const key of stageIdentityKeys) assert.equal(key in env, false, key);

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

test("a candidate whose .upstream is a symbolic link is refused, even onto the harness's own", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-links-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const harness = await preparedTree(at, "harness", "1");
  const other = await preparedTree(at, "other", "2");
  for (const [name, target, pin, version] of [
    ["onto-harness", harness.upstream, harness.commit, "1"],
    ["onto-other", other.upstream, other.commit, "2"],
  ] as const) {
    const dir = join(at, name);
    await mkdir(dir);
    await writeFile(join(dir, "upstream.json"), JSON.stringify({ commit: pin }));
    await writeFile(join(dir, "framework-release.ts"), served(version));
    git(dir, "init", "-q");
    git(dir, "add", "upstream.json", "framework-release.ts");
    git(dir, "commit", "-q", "-m", "candidate");
    await symlink(target, join(dir, ".upstream"));
    assert.throws(
      () => candidateTreeEnvironment(harness.dir, dir),
      /prepared upstream must not be a symbolic link/u,
      name,
    );
  }
});

/** A release entry that only records that it ran. */
async function markingEntry(dir: string) {
  await mkdir(join(dir, "scripts/release"), { recursive: true });
  await writeFile(
    join(dir, "scripts/release/deploy.ts"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("../../entry-ran", import.meta.url), "ran");\n',
  );
  return join(dir, "entry-ran");
}

test("a fresh candidate with no framework build is refused before its entry runs", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-unbuilt-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const candidate = await preparedTree(at, "candidate", "2", { built: false });
  const ran = await markingEntry(candidate.dir);
  // As a caller that forgot `withStageBuild(candidate)` would run it.
  await assert.rejects(
    runEntry("rollback", laneSubject(2), {}, {}, join(at, "outputs"), {
      policy: null,
      include: null,
      tree: candidate.dir,
    }),
    /has no framework build/u,
  );
  assert.equal(existsSync(ran), false);
});

test("on another pin the candidate's own guard tests run once, and a failing one refuses before any entry", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-guard-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const outputs = join(at, "outputs");
  const guardTest = (body: string) =>
    `import { test } from "node:test";\nimport { appendFileSync } from "node:fs";\ntest("guard", () => {\n  appendFileSync("guard-runs.txt", "run\\n");\n  ${body}\n});\n`;

  const failing = await preparedTree(at, "failing", "2");
  const failingRan = await markingEntry(failing.dir);
  await writeFile(
    join(failing.dir, "scripts/release/wire-guard.test.ts"),
    guardTest('throw new Error("the guard lets a write through");'),
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      runEntry("plan", laneSubject(2), {}, {}, outputs, { policy: null, tree: failing.dir }),
      /own guard tests failed on its upstream pin/u,
    );
  assert.equal(existsSync(failingRan), false);
  assert.equal(await readFile(join(failing.dir, "guard-runs.txt"), "utf8"), "run\n");
  const kept = (await readdir(outputs)).filter((name) => name.startsWith("candidate-guard-"));
  assert.equal(kept.length, 1);
  assert.match(await readFile(join(outputs, kept[0]!), "utf8"), /the guard lets a write through/u);

  // A passing guard lets the entry go on to the stage env (which refuses here, holding no secrets).
  const passing = await preparedTree(at, "passing", "3");
  const passingRan = await markingEntry(passing.dir);
  await writeFile(join(passing.dir, "scripts/release/state-store-guard.test.ts"), guardTest(""));
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(
      runEntry("plan", laneSubject(2), {}, {}, outputs, { policy: null, tree: passing.dir }),
      (error: Error) => !/guard tests/u.test(error.message),
    );
  assert.equal(existsSync(passingRan), false);
  assert.equal(await readFile(join(passing.dir, "guard-runs.txt"), "utf8"), "run\n");

  // On the harness's own pin nothing changed, so a failing guard test is not run at all.
  const harness = await preparedTree(at, "harness", "4");
  await writeFile(join(failing.dir, "upstream.json"), JSON.stringify({ commit: harness.commit }));
  await rm(join(failing.dir, "guard-runs.txt"));
  await requireCandidateGuard(harness.dir, failing.dir, outputs);
  assert.equal(existsSync(join(failing.dir, "guard-runs.txt")), false);
});

test("the harness's fault read stays the boot proof only while both trees decode State alike", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "state-decoder-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const tree = async (name: string, versions: Record<string, string>) => {
    const at = join(base, name);
    for (const [pkg, version] of Object.entries(versions)) {
      const dir = join(at, ".upstream/apps/hosted/cloud/node_modules", pkg);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: pkg, version }));
    }
    return at;
  };
  const harness = await tree("harness", { alchemy: "2.0.0-beta.80", effect: "4.0.1" });
  assert.ok(
    sameStateDecoder(harness, await tree("same", { alchemy: "2.0.0-beta.80", effect: "4.0.1" })),
  );
  assert.ok(
    !sameStateDecoder(
      harness,
      await tree("alchemy", { alchemy: "2.0.0-beta.81", effect: "4.0.1" }),
    ),
  );
  assert.ok(
    !sameStateDecoder(harness, await tree("effect", { alchemy: "2.0.0-beta.80", effect: "4.0.2" })),
  );
  // A tree whose versions cannot be read never counts as the same decoder.
  assert.ok(!sameStateDecoder(harness, await tree("missing", { alchemy: "2.0.0-beta.80" })));
  assert.ok(!sameStateDecoder(join(base, "nowhere"), join(base, "nowhere")));
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
  ])
    assert.throws(() => releaseCandidate(JSON.stringify(spec)), /names no/u, JSON.stringify(spec));
  // The committed file names nothing until a run is set up, so a stray label refuses.
  const { readFileSync } = await import("node:fs");
  assert.throws(
    () =>
      releaseCandidate(readFileSync(new URL("./release-candidate.json", import.meta.url), "utf8")),
    /names no rehearse\/ branch/u,
  );
});
