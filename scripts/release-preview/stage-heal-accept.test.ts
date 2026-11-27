import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateTreeRefusal,
  healRelease,
  laneSubject,
  overlayExtent,
  redRelease,
  restartExpectArgs,
  rollbackRetry,
  runEntry,
  stageRelease,
  type CandidateRunServices,
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

/** Every candidate step a mode could take, each recorded and failing, and hooks that do the same. */
function recordingRun(at: string) {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (..._args: unknown[]): never => {
      calls.push(name);
      throw new Error(`${name} ran`);
    };
  const io = {
    spec: record("spec"),
    checkout: record("checkout"),
    prepare: record("prepare"),
    startProbe: record("probe"),
    faultRead: record("fault"),
    device: record("device"),
    withStageBuild: record("build"),
    workerScripts: record("workers"),
  } satisfies CandidateRunServices;
  const hooks = new Proxy(
    {},
    { get: (_target, name) => record(`hooks.${String(name)}`) },
  ) as Parameters<typeof redRelease>[4];
  const source = { PATH: process.env.PATH, HOME: process.env.HOME, RUNNER_TEMP: at };
  return { calls, io, hooks, source, outputs: join(at, "outputs") };
}

const candidateModes = {
  release: (f: ReturnType<typeof recordingRun>) =>
    stageRelease(2, laneSubject(2), f.source, f.outputs, f.hooks, "release", f.io),
  classplan: (f: ReturnType<typeof recordingRun>) =>
    stageRelease(2, laneSubject(2), f.source, f.outputs, f.hooks, "classplan", f.io),
  redrelease: (f: ReturnType<typeof recordingRun>) =>
    redRelease(2, laneSubject(2), f.source, f.outputs, f.hooks, f.io),
  retry: (f: ReturnType<typeof recordingRun>) =>
    rollbackRetry(laneSubject(2), f.source, f.outputs, f.hooks, f.io),
  heal: (f: ReturnType<typeof recordingRun>) =>
    healRelease(2, laneSubject(2), f.source, f.outputs, f.hooks, f.io),
};

test("release, classplan, redrelease, retry and heal refuse before any candidate step", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-refuse-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  for (const [mode, run] of Object.entries(candidateModes)) {
    const fake = recordingRun(join(at, mode));
    await assert.rejects(run(fake), (error: Error) => error.message === candidateTreeRefusal, mode);
    // No spec read, checkout, prepare, probe, fault, device, build, Workers list or native hook.
    assert.deepEqual(fake.calls, [], mode);
    assert.equal(existsSync(join(at, mode)), false, mode);
  }
  assert.equal(
    candidateTreeRefusal,
    "This harness releases no candidate tree: a candidate from another lineage could deploy outside the lane's stack, which the lane's destroy never reads; nothing is checked out or deployed.",
  );
});

test("runEntry refuses any tree but the harness's own before its entry or stage env", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-foreign-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const tree = join(at, "candidate");
  await mkdir(join(tree, "scripts/release"), { recursive: true });
  await writeFile(
    join(tree, "scripts/release/deploy.ts"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("../../entry-ran", import.meta.url), "ran");\n',
  );
  for (const command of ["plan", "deploy", "rollback", "accept"] as const)
    // An empty source: the stage env would refuse otherwise, so this refusal came first.
    await assert.rejects(
      runEntry(command, laneSubject(2), {}, {}, join(at, "outputs"), { policy: null, tree }),
      (error: Error) => error.message === candidateTreeRefusal,
      command,
    );
  assert.equal(existsSync(join(tree, "entry-ran")), false);
  assert.equal(existsSync(join(at, "outputs")), false);
});
