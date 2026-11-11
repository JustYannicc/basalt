import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { releaseEvidence } from "../release-barrier/evidence.ts";
import { executorMarkerSummary } from "../release-barrier/executor-marker-evidence.ts";
import {
  evaluateMarkerRows,
  retainExecutorMarkerReceipt,
} from "../../.upstream/apps/hosted/cloud/src/implementation/executor-version-gate.ts";

const candidate = "b".repeat(40);
const attempt = "00000000-0000-4000-8000-000000000001";
const precondition = {
  transition: {
    baseGitCommit: "a".repeat(40),
    candidateGitCommit: candidate,
    baseToolsCommit: "f69c667936e4c02c75f9d7cc79fb750c230839b9",
    candidateToolsCommit: "2f4c398f3906e0570f0e25a16fa3602329baba29",
  },
  marker: "public.private_executor_settings.key=version",
  expected: "4.0.29",
} as const;

test("a retained refusal reaches the release summary with the exact observed marker", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "executor-marker-evidence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const receipt = evaluateMarkerRows([{ value: "4.0.28" }], precondition, attempt);
  await Effect.runPromise(retainExecutorMarkerReceipt(root, receipt));
  const file = join(root, `executor-version-${attempt}.json`);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), receipt);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const previous = process.env.BASALT_RELEASE_ATTEMPT;
  process.env.BASALT_RELEASE_ATTEMPT = attempt;
  context.after(() => {
    if (previous === undefined) delete process.env.BASALT_RELEASE_ATTEMPT;
    else process.env.BASALT_RELEASE_ATTEMPT = previous;
  });
  const summary = join(root, "summary.md");
  await releaseEvidence(root, candidate).summary(summary, "failed");
  const text = await readFile(summary, "utf8");
  assert.match(text, /public\.private_executor_settings\.key=version/);
  assert.match(text, /Expected: `4\.0\.29`; observed: `4\.0\.28`; outcome: `refused`/);
  assert.ok(text.includes(candidate));
  assert.ok(text.includes(precondition.transition.baseGitCommit));
  assert.match(text, /migration not started/);
  await assert.rejects(executorMarkerSummary(root, "c".repeat(40), attempt), /another release/);
});

test("missing receipts are omitted and arbitrary setting values stay out of evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "executor-marker-private-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await executorMarkerSummary(root, candidate, attempt), "");
  const receipt = evaluateMarkerRows(
    [{ value: "password=synthetic-private-value" }],
    precondition,
    attempt,
  );
  await Effect.runPromise(retainExecutorMarkerReceipt(root, receipt));
  const summary = await executorMarkerSummary(root, candidate, attempt);
  assert.match(summary, /observed: `unavailable`/);
  assert.equal(summary.includes("synthetic-private-value"), false);
  const file = join(root, `executor-version-${attempt}.json`);
  await writeFile(file, JSON.stringify({ ...receipt, observed: "synthetic-private-value" }));
  await assert.rejects(executorMarkerSummary(root, candidate, attempt), /invalid/);
});
