import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { databaseReadinessCommandMs, runDatabaseBudgetCommand } from "./database-budget-command.ts";
import { openDeploymentReadiness, ReadinessResponseError } from "./database-budget-readiness.ts";
import { DatabaseBudgetFailure } from "./database-budget-receipt.ts";
import { handleDeploymentReadiness } from "../src/pool/deployment-readiness.ts";
import { poolLifecycle } from "../src/pool/lifecycle.ts";
import { forcedStopGraceMs } from "../src/pool/runtime-slots/forced-stop.ts";
import { unservingBoundMs } from "../src/pool/runtime-slots/unserving-clock.ts";

const target = { candidate: "a".repeat(40), workerInput: "b".repeat(64), imageHash: "1234abcd" };
const key = "c".repeat(64);
const instanceId = "e".repeat(64);
const runtime = {
  ...target,
  desiredRevisionMatch: true as const,
  instanceId,
  bootId: "boot",
  readyAt: 120_000,
};
const refusal = () =>
  new ReadinessResponseError(503, { outcome: "readiness-error", stage: "readiness" });

/** A clock the test moves: retry pauses elapse at once, and the command deadline fires on time. */
function scheduler(start = 0) {
  const state = { clock: start, pauses: 0 };
  const commands: { at: number; controller: AbortController }[] = [];
  return {
    state,
    now: () => state.clock,
    expire: () => {
      for (const command of commands) command.controller.abort();
    },
    deadline: (milliseconds: number, phase: string) => {
      const controller = new AbortController();
      if (phase === "command") commands.push({ at: state.clock + milliseconds, controller });
      if (phase === "retry") {
        state.pauses++;
        state.clock += milliseconds;
        const due = commands.filter((command) => command.at <= state.clock);
        for (const command of due) command.controller.abort();
        if (!due.length) controller.abort();
      }
      return { signal: controller.signal, dispose: () => {} };
    },
  };
}

async function workspace<T>(run: (path: string, prior: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "budget-adoption-test-"));
  try {
    return await run(join(directory, "receipt.json"), join(directory, "ready.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const source = (path: string, prior?: string) => ({
  DATABASE_BUDGET_WORKER: "fixture-worker",
  CLOUDFLARE_ACCOUNT_ID: "d".repeat(32),
  POOL_DEPLOYMENT_KEY: key,
  GITHUB_SHA: target.candidate,
  DATABASE_BUDGET_WORKER_INPUT: target.workerInput,
  DATABASE_BUDGET_IMAGE_HASH: target.imageHash,
  DATABASE_BUDGET_RECEIPT: path,
  ...(prior
    ? {
        DATABASE_BUDGET_READY_RECEIPT: prior,
        DATABASE_BUDGET_RUNTIME_LOGINS: '["runtime"]',
        DATABASE_BUDGET_DATABASES: '["pool"]',
      }
    : {}),
});

test("readiness waits while the controller object still runs the previous release", async () => {
  await workspace(async (path) => {
    const time = scheduler();
    let runtimeCalls = 0;
    // The new entrypoint answers; the object behind it adopts the new code after two refusals.
    const identity = () => ({
      ...target,
      candidate: runtimeCalls < 3 ? "0".repeat(40) : target.candidate,
      instanceId,
    });
    const result = await runDatabaseBudgetCommand(source(path), ["--ready"], {
      now: time.now,
      deadline: time.deadline,
      open: (options) =>
        openDeploymentReadiness({
          ...options,
          connect: async () => ({
            env: {
              POOL_OPERATIONS: {
                fetch: (request) =>
                  handleDeploymentReadiness(request, target, key, async (phase) => {
                    if (phase === "adoption") return identity();
                    runtimeCalls++;
                    return { ...runtime, ...identity() };
                  }),
              },
            },
            dispose: async () => {},
          }),
        }),
    });
    assert.equal(result.outcome, "converged");
    assert.equal(result.runtime?.bootId, "boot");
    assert.equal(runtimeCalls, 3);
    assert.equal(time.state.pauses, 2);
    assert.equal(time.state.clock, 10_000, "a refused call is retried every five seconds");
    assert.deepEqual(result.refusals, {
      count: 2,
      status: 503,
      outcome: "readiness-error",
      stage: "readiness",
      adopted: false,
      candidateMatches: false,
    });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(saved.ready, runtime);
    assert.equal(saved.refusals.count, 2, "the saved receipt keeps the wait on record");
  });
});

test("readiness refused until its deadline fails with the last refusal", async () => {
  await workspace(async (path) => {
    const time = scheduler();
    let calls = 0,
      closed = 0;
    const run = runDatabaseBudgetCommand(source(path), ["--ready"], {
      now: time.now,
      deadline: time.deadline,
      open: async () => ({
        ready: async () => {
          // First an entrypoint still on the previous version, then the platform mid-swap.
          if (++calls < 3) throw new ReadinessResponseError(calls === 1 ? 409 : 500);
          throw refusal();
        },
        close: async () => {
          closed++;
        },
      }),
    });
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof DatabaseBudgetFailure);
      const { receipt } = error;
      assert.equal(receipt.outcome, "readiness-error");
      assert.equal(receipt.stage, "readiness");
      // 330 s for the object to adopt the code, then the runtime's own 180 s startup budget.
      assert.equal(receipt.commandDeadlineMs, 510_000);
      assert.equal(receipt.elapsedMs, 510_000);
      assert.deepEqual(receipt.refusals, {
        count: 102,
        status: 503,
        outcome: "readiness-error",
        stage: "readiness",
      });
      assert.match(error.message, /"refusals":\{[^}]*"status":503[^}]*"outcome":"readiness-error"/);
      return true;
    });
    assert.equal(calls, 102);
    assert.equal(closed, 1);
    assert.equal(JSON.parse(await readFile(path, "utf8")).refusals.status, 503);
  });
});

// The controller's slowest replacement of a running runtime that keeps refusing, counted from the
// moment its object runs the uploaded code. The waits that carry no name are written as its code
// has them.
const controllerHealMs =
  2_000 + // the alarm turn that meets the refusal
  unservingBoundMs +
  2_000 + // the warm read that decides to stop
  forcedStopGraceMs +
  2 * 2_000 + // two reads confirm the container exited
  1_000 + // the provider admits the restart
  poolLifecycle.startupTimeoutMs +
  14_000 + // the tail of a start
  2_000; // the alarm turn that reports ready

test("readiness outlasts the longest adoption followed by the controller's own heal", async () => {
  await workspace(async (path) => {
    const time = scheduler();
    // The object adopts the code at the last moment the platform allows, then heals at its slowest.
    // The container's destroy and one membership pass have no bound of their own: ten seconds here.
    const servingAt = 330_000 + controllerHealMs + 10_000;
    const result = await runDatabaseBudgetCommand(source(path), ["--ready"], {
      now: time.now,
      deadline: time.deadline,
      open: async () => ({
        ready: async () => {
          if (time.state.clock < servingAt) throw refusal();
          return runtime;
        },
        close: async () => {},
      }),
    });
    assert.equal(result.outcome, "converged");
    assert.equal(result.runtime?.bootId, "boot");
    assert.ok(
      databaseReadinessCommandMs - servingAt >= 30_000,
      "the wait keeps half a minute beyond the slowest heal",
    );
  });
});

test("a deadline during the identity check keeps its last answer on the receipt", async () => {
  await workspace(async (path) => {
    const time = scheduler();
    let probes = 0;
    const run = runDatabaseBudgetCommand(source(path), ["--ready"], {
      now: time.now,
      deadline: time.deadline,
      open: async () => ({
        ready: async () => {
          throw refusal();
        },
        adoption: async (signal) => {
          if (++probes === 2) time.expire();
          signal.throwIfAborted();
          return {
            adopted: false as const,
            observed: { ...target, candidate: "0".repeat(40), instanceId },
          };
        },
        close: async () => {},
      }),
    });
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof DatabaseBudgetFailure);
      assert.equal(error.receipt.outcome, "readiness-error");
      assert.deepEqual(error.receipt.refusals, {
        count: 2,
        status: 503,
        outcome: "readiness-error",
        stage: "readiness",
        adopted: false,
        candidateMatches: false,
      });
      return true;
    });
    assert.equal(probes, 2);
  });
});

for (const status of [401, 404])
  test(`readiness refused with HTTP ${status} fails at once`, async () => {
    await workspace(async (path) => {
      const time = scheduler();
      let calls = 0;
      await assert.rejects(
        runDatabaseBudgetCommand(source(path), ["--ready"], {
          now: time.now,
          deadline: time.deadline,
          open: async () => ({
            ready: async () => {
              calls++;
              throw new ReadinessResponseError(status);
            },
            close: async () => {},
          }),
        }),
        (error) =>
          error instanceof DatabaseBudgetFailure && error.receipt.outcome === "readiness-error",
      );
      assert.equal(calls, 1);
      assert.equal(time.state.pauses, 0);
    });
  });

test("a long wait for readiness leaves verification its whole overall bound", async () => {
  await workspace(async (path, prior) => {
    // Readiness arrived 400 s after its command began: the object took that long to adopt.
    const time = scheduler(400_000);
    await writeFile(
      prior,
      JSON.stringify({ startedAt: 0, readyReceivedAt: 400_000, ready: runtime }),
    );
    let overallDeadline: number | undefined;
    const result = await runDatabaseBudgetCommand(source(path, prior), [], {
      now: time.now,
      deadline: time.deadline,
      open: async () => ({ ready: async () => runtime, close: async () => {} }),
      check: async (options) => {
        overallDeadline = options.overallDeadline;
        await options.retain?.({
          candidate: target.candidate,
          outcome: "converged",
          stage: "converge",
          elapsedMs: 0,
          deadlineMs: 90_000,
          successfulSamples: 1,
          lastSampleAt: time.now(),
          counts: [{ database: "pool", connections: 1 }],
          runtime,
          sampleRuntime: runtime,
        });
        return [{ database: "pool", connections: 1 }];
      },
    });
    assert.equal(result.outcome, "converged");
    assert.equal(overallDeadline, 670_000);
    assert.equal(result.operationStartedAt, 400_000);
    assert.equal(result.overallDeadlineMs, 270_000);
  });
});

test("verification's own readiness call waits through a refusal", async () => {
  await workspace(async (path, prior) => {
    const time = scheduler(10_000);
    await writeFile(
      prior,
      JSON.stringify({ startedAt: 0, readyReceivedAt: 10_000, ready: runtime }),
    );
    let calls = 0;
    const run = runDatabaseBudgetCommand(source(path, prior), [], {
      now: time.now,
      deadline: time.deadline,
      open: async () => ({
        ready: async () => {
          if (++calls === 1) throw refusal();
          return runtime;
        },
        close: async () => {},
      }),
      check: async (options) => {
        assert.ok(options.ready && options.signal);
        assert.equal((await options.ready(options.signal)).bootId, "boot");
        throw new Error("stop after the sample's readiness call");
      },
    });
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof DatabaseBudgetFailure);
      assert.deepEqual(error.receipt.refusals, {
        count: 1,
        status: 503,
        outcome: "readiness-error",
        stage: "readiness",
      });
      return true;
    });
    assert.equal(calls, 2);
    assert.equal(time.state.pauses, 1);
  });
});
