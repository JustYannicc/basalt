import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneSubject, overlayExtent, restartExpectArgs, runEntry } from "./stage.ts";
import {
  candidateTreeEnvironment,
  guardPipeGraceMs,
  requireCandidateGuard,
  requireSameStateDecoder,
  sameStateDecoder,
  settleGroupChild,
  stateReadingSections,
  testsRan,
} from "./stage-candidate.ts";
import {
  build,
  type Decoded,
  decoderTree,
  git,
  markingEntry,
  preparedTree,
  section,
  served,
} from "./stage-candidate-fixtures.ts";

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

test("a candidate whose framework build is a link, or resolves outside its upstream, is refused", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-framework-links-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const harness = await preparedTree(at, "harness", "1");
  const candidate = await preparedTree(at, "candidate", "2", { built: false });
  const other = await preparedTree(at, "other", "2");
  const local = join(candidate.upstream, ".local");
  // The framework directory itself a link onto another tree's build of the same version.
  await mkdir(local, { recursive: true });
  await symlink(join(other.upstream, ".local/basalt-framework"), join(local, "basalt-framework"));
  assert.throws(
    () => candidateTreeEnvironment(harness.dir, candidate.dir),
    /framework build must be its own/u,
  );
  // `.local` a link, so the framework path is a plain directory that resolves into another tree.
  await rm(local, { recursive: true, force: true });
  await symlink(join(other.upstream, ".local"), local);
  assert.throws(
    () => candidateTreeEnvironment(harness.dir, candidate.dir),
    /framework build must be its own/u,
  );
});

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

  // A passing guard lets the entry go on (to the decoder check, which refuses this bare tree).
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

  // A guard file that holds no test, or only a skipped one, proves nothing: `node --test` exits 0.
  for (const [name, body] of [
    ["empty", "export {};\n"],
    ["skipped", 'import { test } from "node:test";\ntest("guard", { skip: true }, () => {});\n'],
  ] as const) {
    const hollow = await preparedTree(at, name, "5");
    const hollowRan = await markingEntry(hollow.dir);
    await writeFile(join(hollow.dir, "scripts/release/wire-guard.test.ts"), body);
    await assert.rejects(
      runEntry("plan", laneSubject(2), {}, {}, outputs, { policy: null, tree: hollow.dir }),
      /own guard tests ran no tests/u,
      name,
    );
    assert.equal(existsSync(hollowRan), false, name);
  }

  // On the harness's own pin nothing changed, so a failing guard test is not run at all.
  const harness = await preparedTree(at, "harness", "4");
  await writeFile(join(failing.dir, "upstream.json"), JSON.stringify({ commit: harness.commit }));
  await rm(join(failing.dir, "guard-runs.txt"));
  await requireCandidateGuard(harness.dir, failing.dir, outputs);
  assert.equal(existsSync(join(failing.dir, "guard-runs.txt")), false);
});

test("the guard child gets no stage secret from the harness's environment", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-guard-env-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const harness = await preparedTree(at, "harness", "1");
  const candidate = await preparedTree(at, "candidate", "2");
  await mkdir(join(candidate.dir, "scripts/release"), { recursive: true });
  await writeFile(
    join(candidate.dir, "scripts/release/state-store-guard.test.ts"),
    'import { test } from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("guard", () => {\n  writeFileSync("guard-env.json", JSON.stringify(process.env));\n});\n',
  );
  await requireCandidateGuard(harness.dir, candidate.dir, join(at, "outputs"), {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CLOUDFLARE_API_TOKEN: "cloudflare-token-value",
    PREVIEW_STATE_KEY: "preview-state-key-value",
  });
  const seen = await readFile(join(candidate.dir, "guard-env.json"), "utf8");
  const env = JSON.parse(seen) as Record<string, string>;
  assert.equal("CLOUDFLARE_API_TOKEN" in env, false);
  assert.equal("PREVIEW_STATE_KEY" in env, false);
  assert.doesNotMatch(seen, /cloudflare-token-value|preview-state-key-value/u);
  // A fresh home of its own as HOME and TMPDIR, gone once the guard is done.
  assert.notEqual(env.HOME, process.env.HOME);
  assert.equal(env.TMPDIR, env.HOME);
  assert.equal(existsSync(env.HOME!), false);
});

test("the guard child finishes within its grace when a process it left holds its pipes", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-guard-pipes-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const pidFile = join(at, "grandchild.pid");
  // It exits at once, leaving a detached process with its stdout and stderr open for a minute.
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
const held = spawn("sleep", ["60"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(held.pid));
held.unref();
console.log("ok 1 - guard");`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  const started = Date.now();
  const settled = await settleGroupChild(child);
  const elapsed = Date.now() - started;
  const held = Number(await readFile(pidFile, "utf8"));
  // The grandchild's pid was captured at its own spawn; it is this test's to stop.
  t.after(() => {
    try {
      process.kill(held, "SIGKILL");
    } catch {}
  });
  assert.deepEqual(settled, { code: 0, timedOut: false });
  assert.match(out, /ok 1 - guard/u);
  // Still alive: only the grace ended the wait, not the grandchild.
  assert.doesNotThrow(() => process.kill(held, 0));
  assert.ok(elapsed >= guardPipeGraceMs - 500, `${elapsed}ms`);
  assert.ok(elapsed < guardPipeGraceMs + 5_000, `${elapsed}ms`);
});

test("testsRan counts only tests that ran, not suites, skips or a file that held none", () => {
  const files = ["scripts/release/wire-guard.test.ts"];
  const block = (type: string) => ["  ---", "  duration_ms: 1", `  type: '${type}'`, "  ..."];
  const tap = (...entries: [line: string, type: string][]) =>
    ["TAP version 13", ...entries.flatMap(([line, type]) => [line, ...block(type)])].join("\n");
  assert.equal(testsRan(tap([`ok 1 - ${files[0]}`, "test"]), files), 0);
  assert.equal(
    testsRan(tap(["ok 1 - guard # SKIP", "test"], ["ok 2 - x # TODO", "test"]), files),
    0,
  );
  assert.equal(testsRan(tap(["ok 1 - a suite", "suite"]), files), 0);
  assert.equal(testsRan(tap(["ok 1 - guard", "test"], ["    not ok 1 - inner", "test"]), files), 2);
  assert.equal(testsRan("", files), 0);
});

// A composed alchemy patch: Basalt's other carries around the sections that read State.
const composed = ({ state = "read", other = "carry" }: { state?: string; other?: string } = {}) =>
  [
    section("src/Cloudflare/Workers/WorkerProvider.ts", other),
    section("src/State/HttpStateApi.ts", state),
    section("lib/State/HttpStateApi.js", state),
    section("package.json", other),
    section("src/Cloudflare/StateStore/Api.ts", state),
    section("lib/Cloudflare/StateStore/Api.js", state),
  ].join("");

test("stateReadingSections keeps only State and State store sections, in order, byte for byte", () => {
  const patch = composed();
  assert.equal(
    stateReadingSections(patch),
    [
      section("src/State/HttpStateApi.ts", "read"),
      section("lib/State/HttpStateApi.js", "read"),
      section("src/Cloudflare/StateStore/Api.ts", "read"),
      section("lib/Cloudflare/StateStore/Api.js", "read"),
    ].join(""),
  );
  // Text before the first header, and a path that only starts like State, are not State reading.
  assert.equal(stateReadingSections(`preamble\n${section("src/StateMachine.ts", "x")}`), "");
  assert.equal(stateReadingSections("--- a\n+++ b\n@@ one\n"), "");
});

test("the harness's fault read stays the boot proof only while both trees decode State alike", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "state-decoder-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const alchemy = {
    version: "2.0.0-beta.80",
    store: "alchemy@2.0.0-beta.80+088b6a62490bc67b",
    patch: composed(),
  };
  const effect = { version: "4.0.1", patch: "--- a\n+++ b\n@@ effect\n" };
  let count = 0;
  const tree = (packages: Record<string, Decoded>) =>
    decoderTree(join(base, `tree-${(count += 1)}`), packages);
  const harness = await tree({ alchemy, effect });
  const differs = async (why: string, packages: Record<string, Decoded>) =>
    assert.ok(!sameStateDecoder(harness, await tree(packages)), why);

  assert.ok(sameStateDecoder(harness, await tree({ alchemy, effect })));
  await differs("alchemy version", { alchemy: { ...alchemy, version: "2.0.0-beta.81" }, effect });
  await differs("effect version", { alchemy, effect: { ...effect, version: "4.0.2" } });
  await differs("store hash", {
    alchemy: { ...alchemy, store: "alchemy@2.0.0-beta.80+1111111111111111" },
    effect,
  });
  // Same version and store entry, another State-reading carry: the version alone reads the same.
  await differs("State sections", {
    alchemy: { ...alchemy, patch: composed({ state: "read differently" }) },
    effect,
  });
  // One more State section, or one fewer, is another decoder too.
  await differs("an extra State section", {
    alchemy: { ...alchemy, patch: composed() + section("src/State/Extra.ts", "x") },
    effect,
  });
  await differs("patch missing on one side", { alchemy: { ...alchemy, patch: undefined }, effect });
  // The effect patch stays compared whole.
  await differs("effect patch bytes", {
    alchemy,
    effect: { ...effect, patch: "--- a\n+++ b\n@@ other\n" },
  });
  // Basalt's other carries may differ: the harness and main carry different sets at one pin.
  assert.ok(
    sameStateDecoder(
      harness,
      await tree({
        alchemy: {
          ...alchemy,
          patch: composed({ other: "another carry" }) + section("src/Bundle/Bundle.ts", "x"),
        },
        effect,
      }),
    ),
    "only other carries differ",
  );
  // Neither tree patching a package is the same for that package.
  const unpatched = { alchemy: { ...alchemy, patch: undefined }, effect };
  assert.ok(sameStateDecoder(await tree(unpatched), await tree(unpatched)));

  // A tree whose decoder cannot be read never counts as the same decoder.
  await differs("effect missing", { alchemy });
  const plain = join(base, "plain");
  for (const { name, version } of [
    { name: "alchemy", version: alchemy.version },
    { name: "effect", version: effect.version },
  ]) {
    const dir = join(plain, ".upstream/apps/hosted/cloud/node_modules", name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }));
  }
  assert.ok(!sameStateDecoder(harness, plain), "not in a bun store");
  assert.ok(!sameStateDecoder(join(base, "nowhere"), join(base, "nowhere")));
});

test("a moved pin with another State decoder is refused before any entry runs", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-decoder-refusal-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const decoder = {
    alchemy: { version: "2.0.0-beta.80", patch: composed() },
    effect: { version: "4.0.1" },
  };
  const harness = await preparedTree(at, "harness", "1");
  const moved = await preparedTree(at, "moved", "2");
  await decoderTree(harness.dir, decoder);
  await decoderTree(moved.dir, {
    ...decoder,
    alchemy: { ...decoder.alchemy, patch: composed({ state: "two" }) },
  });
  assert.throws(
    () => requireSameStateDecoder(harness.dir, moved.dir),
    /alchemy or effect build differs from the harness's where it reads State.*nothing is deployed/u,
  );
  // The same decoder on a moved pin, or the same tree, goes on.
  const same = await preparedTree(at, "same", "3");
  await decoderTree(same.dir, decoder);
  requireSameStateDecoder(harness.dir, same.dir);
  requireSameStateDecoder(moved.dir, moved.dir);

  // Through the entry: its guard passes, and the decoder refusal stops it before it runs.
  const ran = await markingEntry(moved.dir);
  await writeFile(
    join(moved.dir, "scripts/release/state-store-guard.test.ts"),
    'import { test } from "node:test";\ntest("guard", () => {});\n',
  );
  await assert.rejects(
    runEntry("deploy", laneSubject(2), {}, {}, join(at, "outputs"), {
      policy: null,
      tree: moved.dir,
    }),
    /alchemy or effect build differs from the harness's/u,
  );
  assert.equal(existsSync(ran), false);
});

test("on the harness's own pin, another composed patch still has its State reading checked", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-decoder-same-pin-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const decoder = {
    alchemy: { version: "2.0.0-beta.80", patch: composed() },
    effect: { version: "4.0.1", patch: "--- a\n+++ b\n@@ effect\n" },
  };
  const harness = await preparedTree(at, "harness", "1");
  await decoderTree(harness.dir, decoder);
  // A candidate at the harness's own pin.
  const samePin = async (name: string, packages: Record<string, Decoded>) => {
    const tree = await preparedTree(at, name, "1");
    await writeFile(join(tree.dir, "upstream.json"), JSON.stringify({ commit: harness.commit }));
    await decoderTree(tree.dir, packages);
    return tree.dir;
  };
  const refused = /alchemy or effect build differs from the harness's where it reads State/u;
  // Another State-reading carry at the same pin, same version and store entry, is refused.
  const otherState = await samePin("other-state", {
    ...decoder,
    alchemy: { ...decoder.alchemy, patch: composed({ state: "read differently" }) },
  });
  assert.throws(() => requireSameStateDecoder(harness.dir, otherState), refused);
  // Another effect patch at the same pin is refused.
  const otherEffect = await samePin("other-effect", {
    ...decoder,
    effect: { ...decoder.effect, patch: "--- a\n+++ b\n@@ other\n" },
  });
  assert.throws(() => requireSameStateDecoder(harness.dir, otherEffect), refused);
  // Only Basalt's other carries differ: the composed patch differs, its State reading does not.
  const otherCarries = await samePin("other-carries", {
    ...decoder,
    alchemy: { ...decoder.alchemy, patch: composed({ other: "fourteen carries" }) },
  });
  requireSameStateDecoder(harness.dir, otherCarries);
  // The same composed patches at the same pin: nothing to check, as before.
  requireSameStateDecoder(harness.dir, await samePin("identical", decoder));
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
