import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))(
  "yaml",
) as {
  parse(text: string): unknown;
};

// `release.yml`'s live check takes the newest successful deployment in `production` as the commit
// production runs. Every production path writes that record the same way, so none of them can make
// the check skip a commit that was never deployed: it names the deployed candidate, never the run's
// own commit, and it waits on no status checks.
type Step = { name?: string; run?: string; env?: Record<string, string> };
type Job = { if?: string; permissions?: Record<string, string>; steps?: Step[] };
const workflow = async (name: string) =>
  parse(await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8")) as {
    permissions?: Record<string, string>;
    jobs: Record<string, Job>;
  };
const creates = (job: Job) =>
  (job.steps ?? []).flatMap((step) =>
    (step.run ?? "").includes('"repos/$GITHUB_REPOSITORY/deployments" ') ? [step] : [],
  );

test("every production deployment record names the deployed candidate, as the live check reads it", async () => {
  const records = [];
  for (const name of ["release.yml", "production.yml"])
    for (const [id, job] of Object.entries((await workflow(name)).jobs))
      for (const step of creates(job)) records.push({ name, id, job, step });
  assert.deepEqual(
    records.map(({ name, id }) => `${name}:${id}`),
    ["release.yml:release", "production.yml:record"],
  );
  for (const { name, job, step } of records) {
    const run = step.run!;
    assert.match(run, /-f environment=production\b/, name);
    assert.match(run, /-F auto_merge=false\b/, name);
    assert.match(run, /-f 'required_contexts\[\]'/, name);
    const ref = /-f ref="\$(\w+)"/.exec(run)?.[1];
    assert.ok(ref, `${name} names its commit`);
    const source = step.env?.[ref] ?? "";
    // release.yml's job environment carries the candidate under this name.
    assert.ok(
      source === "${{ inputs.candidate }}" || ref === "BASALT_RELEASE_CANDIDATE",
      `${name} records the candidate, not the run's commit`,
    );
    assert.equal(job.permissions?.deployments, "write", name);
  }
});

test("production.yml records every deploy but one that stopped unchanged, from its own result", async () => {
  const production = await workflow("production.yml");
  assert.equal(
    production.permissions?.deployments,
    undefined,
    "no workflow-wide deployments write",
  );
  const record = production.jobs.record!;
  assert.match(record.if ?? "", /inputs\.mode == 'deploy'/);
  // Only a positive "nothing changed" skips the record, so a deploy whose outputs were lost is
  // recorded, as failed.
  assert.match(record.if ?? "", /needs\.production\.outputs\.unchanged != 'true'/);
  assert.match(record.if ?? "", /needs\.production\.outputs\.release != 'skipped'/);
  assert.deepEqual(record.permissions, { actions: "read", deployments: "write" });
  assert.equal(production.jobs.production!.permissions, undefined, "the deploy job is unchanged");
  const step = creates(record)[0]!;
  assert.equal(step.env?.RESULT, "${{ needs.production.result }}");
  // A record that cannot be written fails its job loudly, never as a warning.
  assert.match(step.run!, /::error::/);
  assert.doesNotMatch(step.run!, /::warning::/);
});

const started = "2026-01-01T00:00:00Z";
const own = (id: number, payload: unknown = { path: "production", run: "7" }) => ({
  id,
  created_at: "2026-01-01T00:05:00Z",
  payload,
});

/**
 * production.yml's record step as Actions runs it, against a stand-in `gh` that serves the deploy
 * job's start, a deployments list it keeps in a file, the create and the status, and an instant
 * `sleep`.
 */
async function recordStep(
  t: { after(fn: () => void): void },
  options: { result: string; list?: unknown[]; create?: string; status?: string },
) {
  const step = creates((await workflow("production.yml")).jobs.record!)[0]!;
  const dir = mkdtempSync(join(tmpdir(), "production-record-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const list = join(dir, "list.json");
  writeFileSync(list, JSON.stringify(options.list ?? []));
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      'echo "$@" >> "$GH_CALLS"',
      'case "$*" in',
      `  *statuses*) ${options.status ?? "exit 0"} ;;`,
      `  *jobs*) echo ${started} ;;`,
      '  *deployments\\?environment*) cat "$LIST" ;;',
      `  *) ${options.create ?? "echo 42"} ;;`,
      "esac",
    ].join("\n"),
  );
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "sleep"), 0o755);
  const calls = join(dir, "calls");
  const run = spawnSync("bash", ["-e", "-c", step.run!], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GH_CALLS: calls,
      LIST: list,
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_RUN_ID: "7",
      CANDIDATE: "a".repeat(40),
      RESULT: options.result,
      RUN_URL: "https://example.invalid/run/7",
    },
  });
  const all = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  return {
    status: run.status,
    stdout: run.stdout,
    creates: all.filter((call) => /deployments -f/.test(call)),
    statuses: all.filter((call) => call.includes("statuses")),
  };
}

test("a deploy's record is written once, with the candidate and the deploy's own state", async (t) => {
  for (const [result, state] of [
    ["success", "success"],
    ["failure", "failure"],
    ["cancelled", "failure"],
  ] as const) {
    // An older deployment, created before this deploy began, is no reason to refuse.
    const run = await recordStep(t, {
      result,
      list: [{ id: 9, created_at: "2025-12-31T23:00:00Z", payload: {} }],
    });
    assert.equal(run.status, 0, run.stdout);
    assert.equal(run.creates.length, 1);
    assert.match(run.creates[0]!, new RegExp(`ref=${"a".repeat(40)}`));
    assert.equal(run.statuses.length, 1);
    assert.match(run.statuses[0]!, /deployments\/42\/statuses/);
    assert.match(run.statuses[0]!, new RegExp(`state=${state}`));
  }
});

test("a deployment this run already created is given its state, never a second one", async (t) => {
  // A re-run after a status that failed, with the payload as an object or as the string sent.
  for (const payload of [{ path: "production", run: "7" }, '{"path":"production","run":"7"}']) {
    const run = await recordStep(t, { result: "success", list: [own(41, payload)] });
    assert.equal(run.status, 0, run.stdout);
    assert.equal(run.creates.length, 0);
    assert.match(run.statuses[0]!, /deployments\/41\/statuses/);
  }
  // A create that landed but whose answer was lost: the next try finds it.
  const lost = await recordStep(t, {
    result: "success",
    create: `echo '${JSON.stringify([own(43)])}' > "$LIST"; exit 1`,
  });
  assert.equal(lost.status, 0, lost.stdout);
  assert.equal(lost.creates.length, 1);
  assert.match(lost.statuses[0]!, /deployments\/43\/statuses/);
});

test("a record never claims to be newer than a deploy that recorded after this one began", async (t) => {
  const run = await recordStep(t, {
    result: "success",
    list: [{ id: 50, created_at: "2026-01-01T00:10:00Z", payload: { run: "8" } }],
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /::error::.*a later deploy recorded itself on production/);
  assert.equal(run.creates.length, 0);
  assert.equal(run.statuses.length, 0);
});

test("a record that cannot be written fails its job loudly after its tries", async (t) => {
  const failing = await recordStep(t, { result: "success", status: "exit 1" });
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /::error::The deploy ended success/);
  assert.match(failing.stdout, /Re-run this record job alone/);
  assert.equal(failing.creates.length, 1, "one deployment");
  assert.equal(failing.statuses.length, 5);
  const unrecorded = await recordStep(t, { result: "success", create: "exit 1" });
  assert.equal(unrecorded.status, 1);
  assert.equal(unrecorded.creates.length, 5);
  assert.equal(unrecorded.statuses.length, 0);
});
