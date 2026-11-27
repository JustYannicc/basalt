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
  stageRelease,
  type CandidateRunServices,
} from "./stage.ts";
import { requireCandidateStack } from "./stage-candidate-stack.ts";
import {
  decoderTree,
  healOverlay,
  mainStack,
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

  // Both shapes the heal and release candidates carry go on, the heal overlay's real file included.
  await check(stackHandling);
  await check(healOverlay());
  // The same tree as the harness is not checked at all.
  requireCandidateStack(at, at, stage);

  // Main's real stack file names production's stack.
  await assert.rejects(check(mainStack()), wrongStack);
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
  // Preview names that are no object (a flag, a string) name no preview.
  for (const answer of ["true", '"rehearsal"'])
    await assert.rejects(
      check({
        ...stackHandling,
        "scripts/preview/subject.ts": `export const subjectFromStage = () => ${answer};\n`,
      }),
      production,
      answer,
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

test("the stack check's child gets no secret, an empty home, and reads only its tree", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-stack-env-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  const outside = join(at, "harness-secret.txt");
  await writeFile(outside, "secret");
  const tree = join(at, "tree");
  // It answers a preview only when nothing leaked in and nothing outside the tree can be touched.
  await writeFiles(tree, {
    ...stackHandling,
    "scripts/preview/subject.ts": `import { readFileSync, writeFileSync } from "node:fs";
const denied = (touch: () => unknown) => {
  try {
    touch();
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "ERR_ACCESS_DENIED";
  }
};
export const subjectFromStage = (stage: string) => {
  const env = process.env;
  const clean =
    // macOS adds its own __CF_USER_TEXT_ENCODING to every process.
    !Object.keys(env).some((name) => /TOKEN|SECRET|KEY|CLOUDFLARE/u.test(name)) &&
    env.HOME !== undefined &&
    env.HOME === env.TMPDIR &&
    env.HOME !== ${JSON.stringify(process.env.HOME)};
  const confined =
    denied(() => writeFileSync("written", "")) &&
    denied(() => readFileSync(${JSON.stringify(outside)}, "utf8")) &&
    denied(() => readFileSync(\`\${env.HOME}/anything\`));
  return clean && confined ? { kind: "rehearsal" } : undefined;
};
`,
  });
  requireCandidateStack("/harness", tree, stage, {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CLOUDFLARE_API_TOKEN: "cloudflare-token-value",
  });
  assert.equal(existsSync(join(tree, "written")), false);
});

// The reviewer's tree: the overlay's words only in comments and imports, production's stack in code.
const bypassModules = {
  "scripts/release-barrier/release-stage.ts":
    stackHandling["scripts/release-barrier/release-stage.ts"],
  "scripts/preview/subject.ts": stackHandling["scripts/preview/subject.ts"],
};
const stackFile = (body: string, head = "") => `import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";
import { stackNameForStage } from "./scripts/release-barrier/release-stage.ts";
import { subjectFromStage } from "./scripts/preview/subject.ts";
${head}
${body}
`;
const handled = `export default Alchemy.Stack(
  stackNameForStage(process.env.ALCHEMY_STAGE),
  {},
  Effect.gen(function* () {
    const stage = yield* Stage;
    const previewSubject = subjectFromStage(stage);
    const preview = previewSubject === undefined ? undefined : { subject: previewSubject };
    if (preview === undefined) yield* Effect.log("production only");
  }),
);`;

test("comments, dead code, a second stack or a namer that gates nothing are no rehearsal-stage handling", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-stack-bypass-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  let count = 0;
  const check = async (files: Record<string, string>) => {
    const dir = join(at, `tree-${(count += 1)}`);
    await writeFiles(dir, files);
    return requireCandidateStack("/harness", dir, stage);
  };
  const refused = async (why: string, text: string) =>
    assert.rejects(check({ ...bypassModules, "alchemy.run.ts": text }), unhandled, why);
  // The control: the same modules with the handling in code go on.
  await check({ ...bypassModules, "alchemy.run.ts": stackFile(handled) });

  await refused(
    "the reviewer's tree",
    stackFile(`// Formerly: Alchemy.Stack(stackNameForStage(process.env.ALCHEMY_STAGE), ...)
// const unused = subjectFromStage(stage)
const name = "basalt";
export default Alchemy.Stack(name, {}, Effect.gen(function* () {
  const previewNumber = /^test-pr-([1-9][0-9]*)$/.exec(yield* Stage)?.[1];
}));`),
  );
  await refused(
    "the overlay's stack in a dead branch, production's exported",
    stackFile(`if (false) Alchemy.Stack(stackNameForStage(process.env.ALCHEMY_STAGE), {}, Effect.gen(function* () {}));
const name = "basalt";
export default Alchemy.Stack(name, {}, Effect.gen(function* () {}));`),
  );
  await refused(
    "the namer only in a dead branch",
    stackFile(
      handled.replace(
        "const previewSubject = subjectFromStage(stage);\n    const preview = previewSubject === undefined",
        "if (false) subjectFromStage(stage);\n    const previewNumber = /^test-pr-/u.exec(stage)?.[0];\n    const preview = previewNumber === undefined",
      ),
    ),
  );
  await refused(
    "a second Stack under a variable name",
    stackFile(
      handled,
      'const make = Alchemy.Stack;\nmake("basalt", {}, Effect.gen(function* () {}));',
    ),
  );
  await refused(
    "a second Stack read as a string key",
    stackFile(handled, 'const make = (Effect as never)["Stack"];'),
  );
  await refused(
    "the namer called but its result gating nothing",
    stackFile(
      handled.replace('    if (preview === undefined) yield* Effect.log("production only");\n', ""),
    ),
  );
  await refused(
    "the namer called, and production decided by a pattern instead",
    stackFile(
      handled.replace(
        "previewSubject === undefined ? undefined",
        "/^test-pr-/u.test(stage) === false ? undefined",
      ),
    ),
  );
  await refused(
    "ALCHEMY_STAGE rewritten before the stack is named",
    stackFile(handled, 'process.env.ALCHEMY_STAGE = "production";'),
  );
  await refused(
    "the namer rebound locally",
    stackFile(handled, "const subjectFromStage2 = 1;\nfunction subjectFromStage() {}"),
  );
  await refused(
    "a stack file loaded at runtime instead",
    stackFile(handled, 'await import("./other.ts");'),
  );
});

test("a candidate that would declare a production-only resource on the stage is refused", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-stack-production-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  let count = 0;
  const check = async (files: Record<string, string>) => {
    const dir = join(at, `tree-${(count += 1)}`);
    await writeFiles(dir, files);
    return requireCandidateStack("/harness", dir, stage);
  };
  const overlay = healOverlay();
  const text = overlay["alchemy.run.ts"];
  // The real overlay keeps every production-only id behind its preview decision.
  await check(overlay);
  for (const [why, from, to, named] of [
    [
      "the public site out of its branch",
      "    if (preview === undefined) {\n      // A separate release provisions the database",
      "    if (true) {\n      // A separate release provisions the database",
      /PublicSite/u,
    ],
    [
      "the email domain on both sides",
      "      preview === undefined\n        ? (yield* Cloudflare.Email.SendingSubdomain",
      "      preview !== undefined || true\n        ? (yield* Cloudflare.Email.SendingSubdomain",
      /AuthEmailDomain/u,
    ],
    [
      "the browser check exemption behind another test",
      "    if (preview === undefined) {\n      // API, MCP and CLI clients",
      '    if (preview === undefined || stage !== "") {\n      // API, MCP and CLI clients',
      /ApiBrowserCheckExemption/u,
    ],
  ] as const) {
    assert.ok(text.includes(from), why);
    await assert.rejects(
      check({ ...overlay, "alchemy.run.ts": text.replace(from, to) }),
      (error: Error) => unhandled.test(error.message) && named.test(error.message),
      why,
    );
  }
  // The waiting list's id is written in the module the stack imports; using it ungated declares it.
  const waitlist = "      const waitlist = yield* provisionPublicSiteWaitlist;\n";
  assert.ok(text.includes(waitlist));
  await assert.rejects(
    check({
      ...overlay,
      "alchemy.run.ts": text
        .replace(waitlist, "")
        .replace("    const api = yield* Api;\n", `    const api = yield* Api;\n${waitlist}`),
    }),
    /provisionPublicSiteWaitlist, which declares a production-only id/u,
  );
});

test("a candidate that would deploy outside the lane is refused before any entry or stage env", async (t) => {
  const at = await mkdtemp(join(tmpdir(), "stage-stack-entry-"));
  t.after(() => rm(at, { recursive: true, force: true }));
  for (const [name, stack, refused] of [
    ["main", mainStack(), wrongStack],
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
  const prepared: NodeJS.ProcessEnv[] = [];
  const step = (name: string) => () => {
    steps.push(name);
    throw new Error(`${name} ran`);
  };
  // The asynchronous steps reject, as theirs do.
  const later = (name: string) => () => {
    steps.push(name);
    return Promise.reject(new Error(`${name} ran`));
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
      await writeFiles(dir, {
        "scripts/release/policies/code.json": "{}",
        "src/pool/worker.ts": "export default {};\n",
      });
    },
    prepare: (_dir, env) => {
      steps.push("prepare");
      prepared.push(env);
    },
    startProbe: () => ({ stop: async () => ({ samples: [] }) }),
    faultRead: later("fault"),
    device: step("device"),
    withStageBuild: later("build"),
    workerScripts: later("workers"),
  };
  // Any hook (the native read-backs) is a step too.
  const hooks = new Proxy(
    {},
    { get: (_target, name) => later(`hooks.${String(name)}`) },
  ) as Parameters<typeof redRelease>[4];
  const outputs = join(at, "outputs");
  await mkdir(outputs, { recursive: true });
  // The harness's job env: caches the prepare needs, and a deploy token and job file it must not see.
  const source = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    RUNNER_TEMP: join(at, "runner"),
    BASALT_UPSTREAM_CACHE: join(at, "cache"),
    npm_config_cache: join(at, "npm-cache"),
    CLOUDFLARE_API_TOKEN: "cloudflare-token-value",
    GITHUB_ENV: join(at, "github-env"),
  };
  return { io, hooks, outputs, source, steps, prepared };
}

type Fake = Awaited<ReturnType<typeof fakeRun>>;
const modes = [
  [
    "release",
    (f: Fake) => stageRelease(2, laneSubject(2), f.source, f.outputs, f.hooks, "release", f.io),
  ],
  ["redrelease", (f: Fake) => redRelease(2, laneSubject(2), f.source, f.outputs, f.hooks, f.io)],
  ["retry", (f: Fake) => rollbackRetry(laneSubject(2), f.source, f.outputs, f.hooks, f.io)],
  ["heal", (f: Fake) => healRelease(2, laneSubject(2), f.source, f.outputs, f.hooks, f.io)],
] as const;

test("release, redrelease, retry and heal refuse right after the candidate's prepare, before any device, build or fault", async (t) => {
  const decoderRefusal = /alchemy or effect build differs from the harness's where it reads State/u;
  for (const [why, stack, state, refused] of [
    ["another State-reading carry", stackHandling, "read differently", decoderRefusal],
    ["production's stack", mainStack(), "read", wrongStack],
  ] as const) {
    for (const [mode, run] of modes) {
      const at = await mkdtemp(join(tmpdir(), `stage-early-${mode}-`));
      t.after(() => rm(at, { recursive: true, force: true }));
      const fake = await fakeRun(at, stack, state);
      await assert.rejects(run(fake), refused, `${mode}: ${why}`);
      // Prepared, then refused: no device, build, fault, Workers list or native read ran.
      assert.deepEqual(fake.steps, ["prepare"], `${mode}: ${why}`);
    }
  }
});

test("a candidate that passes goes on from its prepare to the mode's next step, and its prepare sees no token", async (t) => {
  // Each mode's first step after the checks, as the fakes record it; the stage env, composed next
  // from an env with no stage domain or secrets, stops the run before anything reaches the stage.
  const missingSecret = /TEST_STAGE_DOMAIN must be a DNS zone name/u;
  const expected = {
    release: [["prepare", "fault"], missingSecret],
    redrelease: [["prepare"], missingSecret],
    retry: [["prepare", "workers"], /workers ran/u],
    heal: [["prepare", "fault"], /fault ran/u],
  } as const;
  for (const [mode, run] of modes) {
    const at = await mkdtemp(join(tmpdir(), `stage-on-${mode}-`));
    t.after(() => rm(at, { recursive: true, force: true }));
    const fake = await fakeRun(at, stackHandling, "read");
    const [steps, stopped] = expected[mode];
    await assert.rejects(run(fake), stopped, mode);
    assert.deepEqual(fake.steps, steps, mode);
    if (mode === "redrelease")
      // The red commit came after the checks and before the stage env.
      assert.match(
        await readFile(
          join(fake.source.RUNNER_TEMP, "release-candidate/src/pool/worker.ts"),
          "utf8",
        ),
        /rehearsalRedMarker/u,
      );
    assert.deepEqual(
      fake.prepared,
      [
        {
          PATH: fake.source.PATH,
          HOME: fake.source.HOME,
          TMPDIR: fake.source.TMPDIR,
          BASALT_UPSTREAM_CACHE: fake.source.BASALT_UPSTREAM_CACHE,
          npm_config_cache: fake.source.npm_config_cache,
        },
      ],
      mode,
    );
  }
});
