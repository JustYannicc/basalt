import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";

const workflow = readFileSync(
  new URL("../../.github/workflows/release-preview.yml", import.meta.url),
  "utf8",
);
const match =
  /cat > \.local\/validate-compiler-preview\.mjs <<'NODE'\n([\s\S]*?)\n          NODE/.exec(
    workflow,
  );
assert.ok(match, "the trusted inline compiler-preview validator must exist");
const validator = match[1]!.replace(/^          /gm, "").replace(/^import .*;\n/gm, "");
const head = "a".repeat(40);
const base = "b".repeat(40);
const repository = "fixture/basalt";
const pullRequest = {
  number: 42,
  state: "open",
  draft: false,
  head: { sha: head, ref: "feat/upstream-sync-cutover-20261109", repo: { full_name: repository } },
  base: { sha: base, ref: "main", repo: { full_name: repository } },
  labels: [{ name: "compiler-acceptance" }],
};
const event = {
  action: "labeled",
  label: { name: "compiler-acceptance" },
  repository: { full_name: repository },
  pull_request: pullRequest,
};

async function validate(
  options: {
    event?: unknown;
    current?: unknown;
    main?: string;
    checkout?: string;
    revalidate?: boolean;
    savedHead?: string;
    ancestry?: boolean;
  } = {},
): Promise<unknown> {
  const output: string[] = [];
  const saved = {
    status: "candidate-allowed",
    pullRequest: 42,
    head: options.savedHead ?? head,
    base,
    compilerAcceptance: true,
  };
  const context = {
    readFileSync: (path: string) =>
      JSON.stringify(path === "fixture-event.json" ? (options.event ?? event) : saved),
    execFileSync: (_command: string, args: string[]) => {
      if (args[0] === "rev-parse") return options.checkout ?? head;
      assert.deepEqual(Array.from(args), ["merge-base", "--is-ancestor", base, head]);
      if (options.ancestry === false) throw new Error("not an ancestor");
      return "";
    },
    fetch: async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith("/commits/main")
          ? { sha: options.main ?? base }
          : (options.current ?? pullRequest),
    }),
    process: {
      env: {
        GITHUB_REPOSITORY: repository,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: "fixture-event.json",
        GITHUB_TOKEN: "fixture",
      },
      argv: ["node", "validator", ...(options.revalidate ? ["revalidate"] : [])],
      stdout: { write: (value: string) => output.push(value) },
    },
  };
  await new Script(`(async () => {${validator}\n})()`).runInNewContext(context);
  return JSON.parse(output.join("")) as unknown;
}

test("the exact ready cutover event produces a compiler-marked immutable candidate", async () => {
  assert.deepEqual(await validate(), {
    status: "candidate-allowed",
    pullRequest: 42,
    head,
    base,
    compilerAcceptance: true,
  });
  await validate({ revalidate: true });
});

test("lingering labels, other branches, forks and missing exact identity cannot opt in", async () => {
  for (const invalid of [
    { ...event, action: "synchronize" },
    { ...event, label: { name: "release-update" } },
    {
      ...event,
      pull_request: { ...pullRequest, head: { ...pullRequest.head, ref: "feat/other" } },
    },
    {
      ...event,
      pull_request: {
        ...pullRequest,
        head: { ...pullRequest.head, repo: { full_name: "fork/basalt" } },
      },
    },
    { ...event, pull_request: { ...pullRequest, head: { ...pullRequest.head, sha: "main" } } },
  ]) {
    await assert.rejects(validate({ event: invalid }), /exact labeled cutover/);
  }
});

test("live head, base, readiness and label changes refuse deployment", async () => {
  for (const current of [
    { ...pullRequest, state: "closed" },
    { ...pullRequest, draft: true },
    { ...pullRequest, labels: [] },
    { ...pullRequest, head: { ...pullRequest.head, sha: "c".repeat(40) } },
    { ...pullRequest, base: { ...pullRequest.base, sha: "c".repeat(40) } },
  ]) {
    await assert.rejects(validate({ current }), /must remain ready/);
  }
  await assert.rejects(validate({ main: "c".repeat(40) }), /must remain ready/);
  await assert.rejects(validate({ ancestry: false }), /not an ancestor/);
  await assert.rejects(
    validate({ revalidate: true, checkout: "c".repeat(40) }),
    /not the exact event head/,
  );
  await assert.rejects(
    validate({ revalidate: true, savedHead: "c".repeat(40) }),
    /identity changed/,
  );
});

test("workflow keeps trusted-main validation, predeploy revalidation and native teardown wiring", () => {
  assert.ok(workflow.indexOf("ref: main") < workflow.indexOf("validate-compiler-preview.mjs"));
  assert.ok(
    workflow.indexOf("validate-compiler-preview.mjs revalidate") <
      workflow.indexOf('run: node scripts/release-preview/run.ts "$PREVIEW_PR"'),
  );
  assert.match(
    workflow,
    /github\.event\.action == 'labeled'[\s\S]*github\.event\.label\.name == 'compiler-acceptance'[\s\S]*github\.head_ref == 'feat\/upstream-sync-cutover-20261109'/,
  );
  assert.match(workflow, /CANDIDATE_HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /node scripts\/release-merge\/validate-candidate\.ts/);
  assert.match(workflow, /node scripts\/release-preview\/checkpoint\.ts seal/);
  assert.match(workflow, /PREVIEW_MANIFEST_CHECKPOINTED: "1"/);
  assert.match(workflow, /path: preview-receipt\.json/);
});
