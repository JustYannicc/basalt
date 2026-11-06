import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDatabaseBudgetCommand } from "./database-budget-command.ts";
import { DatabaseBudgetFailure } from "./database-budget-receipt.ts";

const runtime = {
  candidate: "a".repeat(40),
  workerInput: "b".repeat(64),
  imageHash: "1234abcd",
  desiredRevisionMatch: true,
  instanceId: "c".repeat(64),
  bootId: "boot",
  readyAt: 120_000,
};

test("the second bridge is bounded by remaining overall time before it can open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "budget-command-test-"));
  let clock = 120_000,
    disposed = 0,
    checked = false;
  const timers: { at: number; controller: AbortController }[] = [];
  const prior = join(directory, "ready.json"),
    path = join(directory, "verification.json");
  try {
    await writeFile(
      prior,
      JSON.stringify({ startedAt: 0, readyReceivedAt: clock, ready: runtime }),
    );
    let finish!: () => void;
    const opening = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = runDatabaseBudgetCommand(
      {
        DATABASE_BUDGET_WORKER: "fixture-worker",
        GITHUB_SHA: runtime.candidate,
        DATABASE_BUDGET_WORKER_INPUT: runtime.workerInput,
        DATABASE_BUDGET_IMAGE_HASH: runtime.imageHash,
        DATABASE_BUDGET_READY_RECEIPT: prior,
        DATABASE_BUDGET_RECEIPT: path,
      },
      [],
      {
        now: () => clock,
        timeout: (milliseconds) => {
          const controller = new AbortController();
          timers.push({ at: clock + milliseconds, controller });
          return controller.signal;
        },
        open: async () => {
          assert.equal(Math.min(...timers.map((timer) => timer.at)), 270_000);
          // Simulate a bridge ignoring cancellation and returning only after the abort has propagated.
          clock = 270_000;
          for (const timer of timers) if (timer.at <= clock) timer.controller.abort();
          await opening;
          return {
            ready: async () => {
              throw new Error("must not warm");
            },
            close: async () => {
              disposed++;
            },
          };
        },
        check: async () => {
          checked = true;
          throw new Error("must not connect");
        },
      },
    );
    await assert.rejects(
      run,
      (error) => error instanceof DatabaseBudgetFailure && error.receipt.outcome === "abort",
    );
    assert.equal(checked, false);
    const retained = JSON.parse(await readFile(path, "utf8"));
    assert.equal(retained.outcome, "abort");
    assert.equal(retained.elapsedMs, 270_000);
    assert.equal(retained.overallDeadlineMs, 270_000);
    assert.equal(retained.target.workerInput, runtime.workerInput);
    assert.equal(retained.runtime.bootId, runtime.bootId);
    finish();
    // Await the fake bridge's completion rather than polling or sleeping.
    await opening;
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(disposed, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
