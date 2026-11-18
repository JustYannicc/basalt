import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkRecord,
  noticeMessage,
  parseCheckRecord,
  parseNoticeMessage,
  rankRetries,
  scrubTitle,
  shardRecord,
  type CheckFile,
} from "./ci/retry-records.ts";

const aggregate = fileURLToPath(new URL("./ci/aggregate-retries.ts", import.meta.url));
const meta = {
  run_id: 7,
  run_attempt: 2,
  head_sha: "0".repeat(40),
  event: "push",
  ref: "refs/heads/main",
  completed_at: "2026-11-18T22:00:00.000Z",
};
const retried = (file: string, conclusion: "passed" | "failed", group = "declared:cloud") => ({
  group,
  file,
  attempts: 2,
  conclusion,
  first_failure: [`${file} fails`],
});

test("the check record merges every shard's retried files and counts both conclusions", () => {
  const record = checkRecord(
    [
      shardRecord("declared-cloud", "declared-cloud-2", [retried("b.spec.ts", "failed")]),
      shardRecord("declared-cloud", "declared-cloud-1", [
        retried("c.spec.ts", "passed"),
        retried("a.spec.ts", "passed"),
      ]),
      shardRecord("declared-local", "declared-local-1", []),
    ],
    meta,
  );
  assert.equal(record.format, "basalt-check-e2e-retries-v1");
  assert.deepEqual(
    [record.retried_files, record.retried_and_passed, record.failed_twice],
    [3, 2, 1],
  );
  assert.deepEqual(
    record.files.map((file) => [file.shard, file.file, file.conclusion]),
    [
      ["declared-cloud-1", "a.spec.ts", "passed"],
      ["declared-cloud-1", "c.spec.ts", "passed"],
      ["declared-cloud-2", "b.spec.ts", "failed"],
    ],
  );
  assert.equal(record.files[0]!.job, "declared-cloud");
  assert.equal(noticeMessage(record), "2 passed on retry, 1 failed twice");
  assert.deepEqual(parseNoticeMessage(noticeMessage(record)), { passed: 2, failed: 1 });
  assert.equal(parseNoticeMessage("Retries: 2"), undefined);
  // A downloaded record reads back to itself; anything else is refused rather than half-read.
  assert.deepEqual(parseCheckRecord(JSON.parse(JSON.stringify(record))), record);
  assert.equal(parseCheckRecord({ ...record, files: [{ file: "a.spec.ts" }] }), undefined);
  assert.equal(parseCheckRecord({ ...record, format: "basalt-e2e-retries-v1" }), undefined);
});

test("the check job publishes a zero record when no shard retried or none ran", () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-retries-"));
  try {
    const run = (directory: string) => {
      const summary = join(root, "summary.md");
      writeFileSync(summary, "");
      const output = join(root, "out/retries.json");
      const result = spawnSync(process.execPath, [aggregate, directory, output], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_RUN_ID: "7",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: "1".repeat(40),
          HEAD_SHA: "2".repeat(40),
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REF: "refs/pull/1/merge",
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      assert.equal(result.status, 0, result.stderr);
      return {
        stdout: result.stdout,
        record: JSON.parse(readFileSync(output, "utf8")),
        summary: readFileSync(summary, "utf8"),
      };
    };
    // Nothing was downloaded at all: the fast lane, or every shard died before writing.
    const empty = run(join(root, "missing"));
    assert.equal(
      empty.stdout.trim(),
      "::notice title=e2e retries::0 passed on retry, 0 failed twice",
    );
    assert.deepEqual(
      [empty.record.retried_files, empty.record.files, empty.record.head_sha, empty.record.run_id],
      [0, [], "2".repeat(40), 7],
    );
    const downloads = join(root, "downloads");
    const save = (artifact: string, value: unknown) => {
      mkdirSync(join(downloads, artifact), { recursive: true });
      writeFileSync(join(downloads, artifact, "retries.json"), JSON.stringify(value));
    };
    save("e2e-retries-declared-cloud-1", shardRecord("declared-cloud", "declared-cloud-1", []));
    save(
      "e2e-retries-declared-cloud-2",
      shardRecord("declared-cloud", "declared-cloud-2", [retried("b.spec.ts", "failed")]),
    );
    save("e2e-retries-declared-local-1", { format: "unknown" });
    const counted = run(downloads);
    assert.match(counted.stdout, /^::warning title=e2e retries::Ignored .*declared-local-1/m);
    assert.match(
      counted.stdout,
      /^::notice title=e2e retries::0 passed on retry, 1 failed twice$/m,
    );
    assert.equal(counted.record.files.length, 1);
    assert.match(
      counted.summary,
      /\| b\.spec\.ts \| declared:cloud \| declared-cloud-2 \| failed twice \|/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("files are ranked by retries and flagged when retried on more than half the runs they ran in", () => {
  const file = (name: string, conclusion: "passed" | "failed", job = "declared-cloud") => ({
    ...retried(name, conclusion, job === "declared-cloud" ? "declared:cloud" : "declared:local"),
    job,
    shard: job + "-1",
  });
  const run = (id: number, jobs: string[], files: CheckFile[]) => ({ run_id: id, jobs, files });
  const ranked = rankRetries([
    run(1, ["declared-cloud"], [file("often.spec.ts", "passed"), file("half.spec.ts", "passed")]),
    run(2, ["declared-cloud"], [file("often.spec.ts", "failed"), file("half.spec.ts", "passed")]),
    run(
      3,
      ["declared-cloud", "declared-local"],
      [file("often.spec.ts", "passed"), file("local.spec.ts", "passed", "declared-local")],
    ),
    run(4, ["declared-cloud"], []),
  ]);
  assert.deepEqual(
    ranked.map((row) => [
      row.file,
      row.retries,
      row.passed_on_retry,
      row.failed_twice,
      row.ran,
      row.action,
    ]),
    [
      ["often.spec.ts", 3, 2, 1, 4, "fix-or-quarantine"],
      // Exactly half is not more than half.
      ["half.spec.ts", 2, 2, 0, 4, undefined],
      // Its job ran only once, so one retry is every run it had.
      ["local.spec.ts", 1, 1, 0, 1, "fix-or-quarantine"],
    ],
  );
  assert.deepEqual(rankRetries([run(1, ["declared-cloud"], [])]), []);
});

test("first-failure titles lose email, host and account-id-like tokens", () => {
  assert.equal(
    scrubTitle("Cloud production operations bind inventories"),
    "Cloud production operations bind inventories",
  );
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
  assert.equal(scrubTitle("\u001b[31mRed\u001b[39m\nnext"), "Red next");
  assert.equal(scrubTitle("x".repeat(400)).length, 200);
});
