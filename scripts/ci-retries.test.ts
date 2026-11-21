import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isCheckJob, rankRetries, shardJob, type RunRetries } from "./ci/retry-history.ts";
import {
  checkRecord,
  expectedShards,
  noticeMessage,
  parseCheckRecord,
  parseNoticeMessage,
  scrubTitle,
  shardRecord,
  type CheckFile,
  type Outcome,
} from "./ci/retry-records.ts";
import { declaredMatrices } from "./ci/shards.ts";

const aggregate = fileURLToPath(new URL("./ci/aggregate-retries.ts", import.meta.url));
const meta = {
  run_id: 7,
  run_attempt: 2,
  head_sha: "0".repeat(40),
  event: "push",
  ref: "refs/heads/main",
  completed_at: "2026-11-18T22:00:00.000Z",
  expected_shards: 3,
};
const retried = (file: string, retry: Outcome, group = "declared:cloud") => ({
  group,
  file,
  attempts: 2,
  conclusion: retry === "passed" ? ("passed" as const) : ("failed" as const),
  retry_outcome: retry,
  first_failure: [`${file} fails`],
});

test("the check record unions every shard attempt and counts each way a retry ends", () => {
  const record = checkRecord(
    [
      shardRecord("declared-cloud", "declared-cloud-2", 1, [retried("b.spec.ts", "failed")]),
      // A rerun of the same shard that passed cleanly keeps attempt 1's failure in the record.
      shardRecord("declared-cloud", "declared-cloud-2", 2, []),
      shardRecord("declared-cloud", "declared-cloud-1", 1, [
        retried("c.spec.ts", "passed"),
        retried("a.spec.ts", "timed-out"),
      ]),
      shardRecord("declared-local", "declared-local-1", 1, []),
    ],
    meta,
  );
  assert.equal(record.format, "basalt-check-e2e-retries-v1");
  assert.deepEqual([record.received_shards, record.complete, record.retried_files], [3, true, 3]);
  assert.deepEqual(
    [record.retried_and_passed, record.failed_twice, record.failed_then_stopped],
    [1, 1, 1],
  );
  assert.deepEqual(
    record.files.map((file) => [file.shard, file.run_attempt, file.file, file.retry_outcome]),
    [
      ["declared-cloud-1", 1, "a.spec.ts", "timed-out"],
      ["declared-cloud-1", 1, "c.spec.ts", "passed"],
      ["declared-cloud-2", 1, "b.spec.ts", "failed"],
    ],
  );
  const notice = noticeMessage(record);
  assert.equal(notice, "1 passed on retry, 1 failed twice, 1 failed then timed out or cancelled");
  assert.deepEqual(parseNoticeMessage(notice), { retried: 3, complete: true });
  assert.equal(parseNoticeMessage("Retries: 2"), undefined);
  // A downloaded record reads back to itself; anything else is refused rather than half-read.
  assert.deepEqual(parseCheckRecord(JSON.parse(JSON.stringify(record))), record);
  for (const broken of [
    { ...record, files: [{ file: "a.spec.ts" }] },
    { ...record, format: "basalt-e2e-retries-v1" },
    { ...record, run_id: "7" },
    { ...record, expected_shards: -1 },
    { ...record, complete: "yes" },
  ])
    assert.equal(parseCheckRecord(broken), undefined);
});

test("a missing shard record makes the count incomplete instead of a confident zero", () => {
  const record = checkRecord([shardRecord("declared-cloud", "declared-cloud-1", 1, [])], meta);
  assert.equal(record.complete, false);
  const notice = noticeMessage(record);
  assert.equal(notice, "0 passed on retry, 0 failed twice (incomplete: 1 of 3 shard records)");
  assert.deepEqual(parseNoticeMessage(notice), { retried: 0, complete: false });
  const unplanned = checkRecord([], { ...meta, expected_shards: null });
  assert.match(noticeMessage(unplanned), /\(incomplete: 0 of \? shard records\)$/);
  const plan = { "declared-cloud": { include: [{}, {}] }, "declared-local": { include: [{}] } };
  assert.equal(expectedShards(JSON.stringify(plan), '["declared-cloud","declared-local"]'), 3);
  // An unselected job's planned rows never run, so they are not expected either.
  assert.equal(expectedShards(JSON.stringify(plan), '["declared-cloud"]'), 2);
  assert.equal(expectedShards(JSON.stringify({ "declared-cloud": { include: [] } }), "[]"), 0);
  for (const [matrices, jobs] of [
    ["", "[]"],
    [undefined, "[]"],
    [JSON.stringify(plan), "{}"],
  ])
    assert.equal(expectedShards(matrices, jobs), null, String(matrices));
});

test("the check job publishes a record whatever was downloaded", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-retries-"));
  try {
    const plan = { "declared-cloud": { include: [{}, {}] }, "declared-local": { include: [{}] } };
    const run = (directory: string) => {
      const summary = join(root, "summary.md");
      writeFileSync(summary, "");
      const output = join(root, "out/retries.json");
      const result = spawnSync(process.execPath, [aggregate, directory, output], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_RUN_ID: "7",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_SHA: "1".repeat(40),
          HEAD_SHA: "2".repeat(40),
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/1/merge",
          GITHUB_STEP_SUMMARY: summary,
          CI_MATRICES: JSON.stringify(plan),
          CI_JOBS: JSON.stringify(["declared-cloud", "declared-local"]),
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return {
        stdout: result.stdout,
        record: JSON.parse(readFileSync(output, "utf8")),
        summary: readFileSync(summary, "utf8"),
      };
    };
    // The download failed or found nothing, while three shards were planned.
    const missing = run(join(root, "missing"));
    assert.equal(
      missing.stdout.trim(),
      "::notice title=e2e retries::0 passed on retry, 0 failed twice (incomplete: 0 of 3 shard records)",
    );
    assert.deepEqual(
      [missing.record.complete, missing.record.expected_shards, missing.record.head_sha],
      [false, 3, "2".repeat(40)],
    );
    const downloads = join(root, "downloads");
    const save = (artifact: string, value: unknown) => {
      mkdirSync(join(downloads, artifact), { recursive: true });
      writeFileSync(join(downloads, artifact, "retries.json"), JSON.stringify(value));
    };
    save(
      "e2e-retries-declared-cloud-1-1",
      shardRecord("declared-cloud", "declared-cloud-1", 1, []),
    );
    save(
      "e2e-retries-declared-cloud-2-1",
      shardRecord("declared-cloud", "declared-cloud-2", 1, [retried("b.spec.ts", "failed")]),
    );
    save(
      "e2e-retries-declared-cloud-2-2",
      shardRecord("declared-cloud", "declared-cloud-2", 2, []),
    );
    save(
      "e2e-retries-declared-local-1-1",
      shardRecord("declared-local", "declared-local-1", 1, []),
    );
    save("e2e-retries-unreadable-1", { format: "unknown" });
    const counted = run(downloads);
    assert.match(counted.stdout, /^::warning title=e2e retries::Ignored .*unreadable-1/m);
    assert.match(
      counted.stdout,
      /^::notice title=e2e retries::0 passed on retry, 1 failed twice$/m,
    );
    assert.deepEqual([counted.record.complete, counted.record.files.length], [true, 1]);
    assert.match(
      counted.summary,
      /\| b\.spec\.ts \| declared:cloud \| declared-cloud-2 \| 1 \| failed twice \|/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the reader recognises the job names the planner and ci.yml actually produce", () => {
  for (const [job, { include }] of Object.entries(declaredMatrices()))
    for (const { shard } of include) assert.equal(shardJob(shard), job, shard);
  assert.equal(shardJob("declared-cloud (pool.spec.ts, declared:cloud)"), undefined);
  assert.equal(shardJob("check"), undefined);
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const names = /&& '([^']+)' \|\| '([^']+)' }}$/.exec(workflow.jobs.check.name)?.slice(1);
  assert.equal(names?.length, 2, workflow.jobs.check.name);
  for (const name of names!) assert.ok(isCheckJob(name), name);
  for (const name of ["checks", "check-e2e-retries", "declared-cloud-1"])
    assert.equal(isCheckJob(name), false, name);
});

test("files are ranked by retries and flagged when retried on more than half the runs they ran in", () => {
  const file = (name: string, retry: Outcome, job = "declared-cloud"): CheckFile => ({
    ...retried(name, retry, job === "declared-cloud" ? "declared:cloud" : "declared:local"),
    job,
    shard: job + "-1",
    run_attempt: 1,
  });
  const run = (id: number, jobs: string[], files: CheckFile[], complete = true): RunRetries => ({
    run_id: id,
    complete,
    jobs,
    files,
  });
  const ranked = rankRetries([
    run(1, ["declared-cloud"], [file("often.spec.ts", "passed"), file("half.spec.ts", "passed")]),
    run(2, ["declared-cloud"], [file("often.spec.ts", "failed"), file("half.spec.ts", "passed")]),
    run(
      3,
      ["declared-cloud", "declared-local"],
      [
        file("often.spec.ts", "passed"),
        // The same file retried in two attempts of one run counts once, as its worse result.
        { ...file("often.spec.ts", "failed"), run_attempt: 2 },
        file("local.spec.ts", "passed", "declared-local"),
      ],
    ),
    run(4, ["declared-cloud"], []),
    // Missing shard records: it counts only for the files it shows were retried.
    run(5, ["declared-cloud"], [file("stopped.spec.ts", "cancelled")], false),
    run(6, ["declared-cloud"], [], false),
  ]);
  assert.deepEqual(
    ranked.map((row) => [
      row.file,
      row.retries,
      row.passed_on_retry,
      row.failed_twice,
      row.failed_then_stopped,
      row.ran,
      row.action,
    ]),
    [
      ["often.spec.ts", 3, 1, 2, 0, 4, "fix-or-quarantine"],
      // Exactly half is not more than half.
      ["half.spec.ts", 2, 2, 0, 0, 4, undefined],
      ["stopped.spec.ts", 1, 0, 0, 1, 5, undefined],
      // Its job ran only once, so one retry is every run it had.
      ["local.spec.ts", 1, 1, 0, 0, 1, "fix-or-quarantine"],
    ],
  );
  assert.deepEqual(rankRetries([run(1, ["declared-cloud"], [])]), []);
});

test("first-failure titles lose URL, email, address, host and account-id-like tokens", () => {
  const plain = "Cloud production operations bind inventories";
  assert.equal(scrubTitle(plain), plain);
  assert.equal(
    scrubTitle("Owner owner+ci@example.com reaches api.example.test as acct_9f8e7d6c5b"),
    "Owner [redacted] reaches [redacted] as [redacted]",
  );
  assert.equal(
    scrubTitle(
      "Account 123456789012 or 0f1e2d3c4b5a69788796a5b4c3d2e1f0 or 0b9c6a2e-0d1f-4c55-9a0b-1c2d3e4f5a6b",
    ),
    "Account [redacted] or [redacted] or [redacted]",
  );
  assert.equal(
    scrubTitle("Opens https://user:secret@app.example.test:8443/path?q=1 then ftp://files"),
    "Opens [url] then [url]",
  );
  assert.equal(
    scrubTitle("Binds 10.0.0.12 and 192.168.1.4:5432, then localhost:8787 and LOCALHOST"),
    "Binds [redacted] and [redacted], then [redacted] and [redacted]",
  );
  assert.equal(scrubTitle("\u001b[31mRed\u001b[39m\nnext"), "Red next");
  assert.equal(scrubTitle("x".repeat(400)).length, 200);
});
