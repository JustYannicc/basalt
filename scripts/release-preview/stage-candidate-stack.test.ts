import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  healRelease,
  laneSubject,
  redRelease,
  rollbackRetry,
  runEntry,
  type CandidateRunServices,
} from "./stage.ts";
import { requireCandidateStack } from "./stage-candidate-stack.ts";
import {
  decoderTree,
  markingEntry,
  preparedTree,
  preparedTreeAt,
  section,
  stackHandling,
  writeFiles,
} from "./stage-candidate-fixtures.ts";

const stage = "test-rehearsal-2";
const wrongStack =
  /names stack basalt for this stage, not the lane's basalt-rehearsal.*nothing is deployed/u;
const unhandled = /has no rehearsal-stage handling.*nothing is deployed/u;
const production = /takes this stage for production.*nothing is deployed/u;

// The heal overlay's other shape: both functions from one stage-only module.
const overlayShape = {
  "alchemy.run.ts": `import { disposableStageNames, stackNameForStage } from "./scripts/preview/rehearsal-stage.ts";
export default Alchemy.Stack(
  stackNameForStage(process.env.ALCHEMY_STAGE),
  { providers: cloudProviders, state: stackState },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const previewNames = disposableStageNames(stage);
  }),
);
`,
  "scripts/preview/rehearsal-stage.ts": `export const stackNameForStage = (stage: string | undefined) =>
  stage !== undefined && /^test-rehearsal-[1-9][0-9]{0,9}$/u.test(stage) ? "basalt-rehearsal" : "basalt";
export const disposableStageNames = (stage: string) =>
  /^test-(?:pr|rehearsal)-/u.test(stage) ? { slug: stage.slice(5) } : undefined;
`,
};
// Main's stack file: production's stack by name, and previews only for pull requests.
const mainShape = {
  "alchemy.run.ts": `export default Alchemy.Stack(
  "basalt",
  { providers: cloudProviders, state: stackState },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const previewNumber = /^test-pr-([1-9][0-9]*)$/.exec(stage)?.[1];
  }),
);
`,
};

test("a candidate deploys a rehearsal stage only into the lane's own stack, read from its stack file", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-stack-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  let count = 0;
  const tree = async (files: Record<string, string>) => {
    const dir = join(at, `tree-${(count += 1)}`);
    await writeFiles(dir, files);
    return dir;
  };
  const check = async (files: Record<string, string>) =>
    requireCandidateStack("/harness", await tree(files), stage);

  // Both shapes the heal and release candidates carry go on.
  await check(stackHandling);
  await check(overlayShape);
  // The same tree as the harness is not checked at all.
  requireCandidateStack(at, at, stage);

  // Main names production's stack.
  await assert.rejects(check(mainShape), wrongStack);
  // A stackNameForStage of its own that maps the stage to production's stack.
  await assert.rejects(
    check({
      ...stackHandling,
      "scripts/release-barrier/release-stage.ts":
        'export const stackNameForStage = () => "basalt";\n',
    }),
    wrongStack,
  );
  // A stack named some other way: nothing here can say which stack it is.
  await assert.rejects(
    check({
      ...stackHandling,
      "alchemy.run.ts": stackHandling["alchemy.run.ts"].replace(
        "stackNameForStage(process.env.ALCHEMY_STAGE)",
        "stackFor(process.env.ALCHEMY_STAGE)",
      ),
    }),
    unhandled,
  );
  // No stack file at all.
  await assert.rejects(check({ "README.md": "" }), unhandled);
  // The right stack, but previews still only for pull requests: production's names in the lane.
  await assert.rejects(
    check({
      ...stackHandling,
      "alchemy.run.ts": stackHandling["alchemy.run.ts"].replace(
        "const previewSubject = subjectFromStage(stage);",
        "const previewNumber = /^test-pr-([1-9][0-9]*)$/.exec(stage)?.[1];",
      ),
    }),
    unhandled,
  );
  // A namer of its own that does not cover a rehearsal stage.
  await assert.rejects(
    check({
      ...stackHandling,
      "scripts/preview/subject.ts": "export const subjectFromStage = () => undefined;\n",
    }),
    production,
  );
  // A namer that throws, or a module that cannot be loaded, is not handling either.
  await assert.rejects(
    check({
      ...stackHandling,
      "scripts/preview/subject.ts":
        'export const subjectFromStage = () => { throw new Error("x"); };\n',
    }),
    unhandled,
  );
  // stackNameForStage imported from outside the tree, or through a link, is not its own.
  await assert.rejects(
    check({
      ...stackHandling,
      "alchemy.run.ts": stackHandling["alchemy.run.ts"].replace(
        "./scripts/release-barrier/release-stage.ts",
        "../tree-1/scripts/release-barrier/release-stage.ts",
      ),
    }),
    unhandled,
  );
  const linked = await tree({
    "alchemy.run.ts": stackHandling["alchemy.run.ts"],
    "scripts/preview/subject.ts": stackHandling["scripts/preview/subject.ts"],
  });
  await mkdir(join(linked, "scripts/release-barrier"), { recursive: true });
  await symlink(
    join(at, "tree-1/scripts/release-barrier/release-stage.ts"),
    join(linked, "scripts/release-barrier/release-stage.ts"),
  );
  assert.throws(() => requireCandidateStack("/harness", linked, stage), unhandled);
});

test("the stack check's child gets no stage secret from the harness's environment", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-stack-env-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  await writeFiles(at, {
    ...stackHandling,
    "scripts/preview/subject.ts": `import { writeFileSync } from "node:fs";
export const subjectFromStage = (stage: string) => {
  writeFileSync("stack-env.json", JSON.stringify(process.env));
  return { kind: "rehearsal" };
};
`,
  });
  requireCandidateStack("/harness", at, stage, {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CLOUDFLARE_API_TOKEN: "cloudflare-token-value",
  });
  const seen = await readFile(join(at, "stack-env.json"), "utf8");
  assert.doesNotMatch(seen, /CLOUDFLARE_API_TOKEN|cloudflare-token-value/u);
});

test("a candidate that would deploy outside the lane is refused before any entry or stage env", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-stack-entry-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  for (const [name, stack, refused] of [
    ["main", mainShape, wrongStack],
    ["unhandled", { "README.md": "" }, unhandled],
  ] as const) {
    // Unbuilt, on another pin, with a failing guard test: each of those would refuse later.
    const candidate = await preparedTree(at, name, "2", { built: false, stack });
    const ran = await markingEntry(candidate.dir);
    await writeFile(
      join(candidate.dir, "scripts/release/wire-guard.test.ts"),
      'import { test } from "node:test";\nimport { writeFileSync } from "node:fs";\ntest("guard", () => { writeFileSync("guard-ran", ""); });\n',
    );
    // An empty source: had the stage env been composed, it would have refused on a missing secret.
    await assert.rejects(
      runEntry("plan", laneSubject(2), {}, {}, join(at, "outputs"), {
        policy: null,
        tree: candidate.dir,
      }),
      refused,
      name,
    );
    assert.equal(existsSync(ran), false, name);
    assert.equal(existsSync(join(candidate.dir, "guard-ran")), false, name);
  }
});

// The early checks in redrelease, retry and heal, against fake services that record each step.
const decoder = (state: string) => ({
  alchemy: {
    version: "2.0.0-beta.80",
    patch:
      section("src/Cloudflare/Workers/Worker.ts", "carry") + section("src/State/Api.ts", state),
  },
  effect: { version: "4.0.1" },
});

async function fakeRun(at: string, candidateStack: Record<string, string>, candidateState: string) {
  const harness = await preparedTree(at, "harness", "1");
  await decoderTree(harness.dir, decoder("read"));
  const steps: string[] = [];
  const step = (name: string) => () => {
    steps.push(name);
    throw new Error(`${name} ran`);
  };
  const io: CandidateRunServices = {
    harness: harness.dir,
    spec: async (name) =>
      name === "rollback-retry.json"
        ? JSON.stringify({ fqn: "PoolWorker", servedBefore: "2026-11-20T10:00:00Z" })
        : JSON.stringify({ branch: "rehearse/early-checks", policy: "code" }),
    checkout: async (_branch, dir) => {
      const tree = await preparedTreeAt(dir, "2", { stack: candidateStack });
      await writeFile(
        join(tree.upstream, "../upstream.json"),
        JSON.stringify({ commit: harness.commit }),
      );
      await decoderTree(dir, decoder(candidateState));
      await writeFiles(dir, { "scripts/release/policies/code.json": "{}" });
    },
    prepare: () => void steps.push("prepare"),
    startProbe: () => ({ stop: async () => ({ samples: [] }) }),
    faultRead: step("fault"),
    device: step("device"),
    withStageBuild: step("build"),
    workerScripts: step("workers"),
  };
  // Any hook (the native read-backs) is a step too.
  const hooks = new Proxy(
    {},
    { get: (_target, name) => step(`hooks.${String(name)}`) },
  ) as Parameters<typeof redRelease>[4];
  const outputs = join(at, "outputs");
  await mkdir(outputs, { recursive: true });
  const source = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    RUNNER_TEMP: join(at, "runner"),
  };
  return { io, hooks, outputs, source, steps };
}

test("redrelease, retry and heal refuse right after the candidate's prepare, before any device, build or fault", async (t) => {
  const decoderRefusal = /alchemy or effect build differs from the harness's where it reads State/u;
  for (const [why, stack, state, refused] of [
    ["another State-reading carry", stackHandling, "read differently", decoderRefusal],
    ["production's stack", mainShape, "read", wrongStack],
  ] as const) {
    for (const [mode, run] of [
      [
        "redrelease",
        (f: Awaited<ReturnType<typeof fakeRun>>) =>
          redRelease(2, laneSubject(2), f.source, f.outputs, f.hooks, f.io),
      ],
      [
        "retry",
        (f: Awaited<ReturnType<typeof fakeRun>>) =>
          rollbackRetry(laneSubject(2), f.source, f.outputs, f.hooks, f.io),
      ],
      [
        "heal",
        (f: Awaited<ReturnType<typeof fakeRun>>) =>
          healRelease(2, laneSubject(2), f.source, f.outputs, f.hooks, f.io),
      ],
    ] as const) {
      const at = await mkdtemp(join(tmpdir(), `stage-early-${mode}-`));
      t.after(() => rm(at, { recursive: true, force: true }));
      const fake = await fakeRun(at, stack, state);
      await assert.rejects(run(fake), refused, `${mode}: ${why}`);
      // Prepared, then refused: no device, build, fault, Workers list or native read ran.
      assert.deepEqual(fake.steps, ["prepare"], `${mode}: ${why}`);
    }
  }
});
