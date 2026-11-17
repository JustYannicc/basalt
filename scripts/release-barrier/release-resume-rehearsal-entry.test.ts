import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { probeNeeded } from "./probe-paths.ts";
import { assertReadOnlyRehearsalContext } from "./release-resume-rehearsal-receipt.ts";

const { parse } = createRequire(new URL("../architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
);

test("rehearsal context rejects forks, pushes and non-main PRs", () => {
  const source = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REPOSITORY: "JustYannicc/basalt",
    GITHUB_REF: "refs/pull/42/merge",
    GITHUB_SHA: "9".repeat(40),
  };
  const event = {
    pull_request: {
      head: { sha: "a".repeat(40), repo: { full_name: "JustYannicc/basalt" } },
      base: { ref: "main" },
    },
  };
  assert.deepEqual(assertReadOnlyRehearsalContext(source, event), {
    candidate: source.GITHUB_SHA,
    head: event.pull_request.head.sha,
  });
  for (const rejected of [
    [{ ...source, GITHUB_EVENT_NAME: "push" }, event],
    [
      source,
      {
        ...event,
        pull_request: {
          ...event.pull_request,
          head: { ...event.pull_request.head, repo: { full_name: "fork/basalt" } },
        },
      },
    ],
    [source, { ...event, pull_request: { ...event.pull_request, base: { ref: "release" } } }],
  ] as const)
    assert.throws(
      () => assertReadOnlyRehearsalContext(rejected[0]!, rejected[1]!),
      /untrusted-context/,
    );
});

test("Check selects the same-repository rehearsal only for affected release-barrier changes", () => {
  assert.equal(probeNeeded(["scripts/release-barrier/release-resume-rehearsal-entry.ts"]), true);
  assert.equal(probeNeeded(["scripts/release-barrier/release-resume-rehearsal.ts"]), true);
  assert.equal(probeNeeded(["docs/pools.md"]), false);
  const job = workflow.jobs["baseline-probe"];
  assert.match(job.if, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(job.if, /needs\.select\.outputs\.baseline_probe == 'true'/);
  assert.equal(job.environment, undefined);
  const step = job.steps.find(
    (candidate: { name?: string }) =>
      candidate.name === "Rehearse baseline controller reconciliation read-only",
  );
  assert.ok(step);
  assert.match(step.if, /always\(\).*steps\.probe-candidate\.outcome == 'success'/s);
  assert.match(step.if, /steps\.prepare-upstream\.outcome == 'success'/);
  assert.match(step.run, /release-resume-rehearsal-entry\.ts/);
  assert.deepEqual(Object.keys(step.env).sort(), [
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "EXECUTOR_ENCRYPTION_KEY",
    "GITHUB_SHA",
  ]);
  assert.doesNotMatch(step.run, /deploy|release\.ts/);
});

test("the rehearsal executable records a refusal without credentials or a trusted CI event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-rehearsal-entry-"));
  try {
    const entry = new URL("./release-resume-rehearsal-entry.ts", import.meta.url).pathname;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "data:text/javascript,globalThis.fetch=()=>{throw new Error('Unexpected network in untrusted rehearsal')}",
        entry,
      ],
      {
        cwd: directory,
        env: { PATH: process.env.PATH, GITHUB_ACTIONS: "false" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(
      await readFile(join(directory, ".local/release-resume-rehearsal/receipt.json"), "utf8"),
    );
    assert.equal(receipt.status, "refused");
    assert.equal(receipt.failure.reason, "release-rehearsal-event-unavailable");
    assert.deepEqual(receipt.mutations, {
      state: 0,
      infrastructure: 0,
      runtime: 0,
      deniedStateWriteAttempts: 0,
      blockedHttpMutationAttempts: 0,
      refusedRuntimeCommands: 0,
      refusedRuntimeRequests: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
