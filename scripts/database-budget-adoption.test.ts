import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { databaseReadinessCommandMs, runDatabaseBudgetCommand } from "./database-budget-command.ts";
import { openDeploymentReadiness, ReadinessResponseError } from "./database-budget-readiness.ts";
import { DatabaseBudgetFailure } from "./database-budget-receipt.ts";
import { handleDeploymentReadiness } from "../src/pool/deployment-readiness.ts";
import {
  controllerAdoptionMs,
  destroyAndMembershipMs,
  forcedRestartServesWithinHeldStreamsMs,
  healingReadinessWithinMs,
} from "../src/pool/runtime-slots/forced-restart-timing.ts";

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
/** One call every five seconds from the start of the wait until its deadline. */
const refusedCalls = Math.ceil(databaseReadinessCommandMs / 5_000);
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
        // The command deadline cuts a pause short, as it does live: the clock stops there.
        state.clock = Math.min(
          state.clock + milliseconds,
          ...commands.map((command) => command.at).filter((at) => at > state.clock),
        );
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
      assert.equal(receipt.commandDeadlineMs, databaseReadinessCommandMs);
      assert.equal(receipt.elapsedMs, databaseReadinessCommandMs);
      assert.deepEqual(receipt.refusals, {
        count: refusedCalls,
        status: 503,
        outcome: "readiness-error",
        stage: "readiness",
      });
      assert.match(error.message, /"refusals":\{[^}]*"status":503[^}]*"outcome":"readiness-error"/);
      return true;
    });
    assert.equal(calls, refusedCalls);
    assert.equal(closed, 1);
    assert.equal(JSON.parse(await readFile(path, "utf8")).refusals.status, 503);
  });
});

test("readiness outlasts the longest adoption followed by the controller's own heal", async () => {
  await workspace(async (path) => {
    const time = scheduler();
    // The object adopts the code at the last moment the platform allows, then heals at its slowest
    // with a stream count that stands still; destroy and the membership pass take their whole
    // allowance, less one pause between readiness attempts.
    const servingAt =
      controllerAdoptionMs +
      forcedRestartServesWithinHeldStreamsMs +
      destroyAndMembershipMs -
      5_000;
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
    assert.equal(
      databaseReadinessCommandMs,
      healingReadinessWithinMs,
      "the wait is the derived bound",
    );
    assert.ok(databaseReadinessCommandMs >= servingAt + 5_000, "the wait covers the slowest heal");
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

/** A readiness connection over a bridge whose every request is answered by `answer`. */
const over =
  (answer: (request: Request) => Response | Promise<Response>, closed: () => void) =>
  (options: Parameters<typeof openDeploymentReadiness>[0]) =>
    openDeploymentReadiness({
      ...options,
      connect: async () => ({
        env: { POOL_OPERATIONS: { fetch: async (request: Request) => answer(request) } },
        dispose: async () => closed(),
      }),
    });

test("a readiness bridge that fails is opened again inside the deadline, and readiness completes", async () => {
  await workspace(async (path) => {
    const time = scheduler();
    let opens = 0,
      closed = 0;
    const result = await runDatabaseBudgetCommand(source(path), ["--ready"], {
      now: time.now,
      deadline: time.deadline,
      open: (options) => {
        opens++;
        const first = opens === 1;
        return over(
          (request) => {
            // The first bridge fails in the bridge itself; a fresh one reaches the Worker.
            if (first) throw new Error("Private operations Node bridge exited");
            return handleDeploymentReadiness(request, target, key, async () => ({ ...runtime }));
          },
          () => closed++,
        )(options);
      },
    });
    assert.equal(result.outcome, "converged");
    assert.equal(opens, 2, "one fresh bridge");
    assert.equal(
      closed,
      2,
      "the failed bridge is closed before the next opens, and the last at the end",
    );
    assert.equal(time.state.pauses, 1, "it waits one pause before it opens again");
  });
});

test("readiness opens no second bridge for an answer, a refusal it does not wait through, or its deadline", async () => {
  for (const [label, answer] of [
    ["a 401", () => new Response(null, { status: 401 })],
    ["a 404", () => new Response(null, { status: 404 })],
    ["a reply that does not decode", () => Response.json({ nothing: true })],
    ["another candidate's runtime", () => Response.json({ ...runtime, candidate: "0".repeat(40) })],
  ] as const)
    await workspace(async (path) => {
      const time = scheduler();
      let opens = 0;
      const run = runDatabaseBudgetCommand(source(path), ["--ready"], {
        now: time.now,
        deadline: time.deadline,
        open: (options) => {
          opens++;
          return over(answer, () => {})(options);
        },
      });
      await assert.rejects(run, DatabaseBudgetFailure, label);
      assert.equal(opens, 1, label);
    });
  // Its own deadline ends the call in flight: that is the wait ending, not the bridge failing.
  await workspace(async (path) => {
    const time = scheduler();
    let opens = 0;
    const run = runDatabaseBudgetCommand(source(path), ["--ready"], {
      now: time.now,
      deadline: time.deadline,
      open: (options) => {
        opens++;
        return over(
          () => {
            setImmediate(() => time.expire());
            return new Promise<Response>(() => {});
          },
          () => {},
        )(options);
      },
    });
    await assert.rejects(run, DatabaseBudgetFailure);
    assert.equal(opens, 1, "the deadline");
  });
});

test("a readiness bridge that keeps failing is opened again only inside the deadline", async () => {
  await workspace(async (path) => {
    const time = scheduler();
    let opens = 0,
      closed = 0;
    const run = runDatabaseBudgetCommand(source(path), ["--ready"], {
      now: time.now,
      deadline: time.deadline,
      open: (options) => {
        opens++;
        // Without its pause the wait would never let the clock move: end it instead of hanging,
        // and the count below fails.
        if (opens > refusedCalls + 2) {
          time.expire();
          throw new Error("reopened without pausing");
        }
        return over(
          () => {
            throw new Error("Private operations Node bridge exited");
          },
          () => closed++,
        )(options);
      },
    });
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof DatabaseBudgetFailure);
      assert.equal(error.receipt.outcome, "readiness-error");
      assert.equal(error.receipt.elapsedMs, databaseReadinessCommandMs);
      return true;
    });
    // One bridge, then one more after each pause the deadline lets through.
    assert.ok(opens > 1 && opens <= refusedCalls, String(opens));
    assert.equal(closed, opens, "every bridge it opened is closed");
  });
});

test("a fresh readiness bridge that fails to open is tried again inside the deadline", async () => {
  await workspace(async (path) => {
    const time = scheduler();
    let opens = 0;
    const result = await runDatabaseBudgetCommand(source(path), ["--ready"], {
      now: time.now,
      deadline: time.deadline,
      open: (options) => {
        opens++;
        // The first bridge dies on its request, the next one fails to open, the third answers.
        if (opens === 2)
          return Promise.reject(new Error("Private operations Node bridge startup timed out"));
        const first = opens === 1;
        return over(
          (request) => {
            if (first) throw new Error("Private operations Node bridge exited");
            return handleDeploymentReadiness(request, target, key, async () => ({ ...runtime }));
          },
          () => {},
        )(options);
      },
    });
    assert.equal(result.outcome, "converged");
    assert.equal(opens, 3);
    assert.equal(time.state.pauses, 2, "a pause before each fresh bridge");
  });
});

test("a deadline that ends while the failed bridge closes opens no fresh one", async () => {
  await workspace(async (path) => {
    const time = scheduler();
    let opens = 0;
    const run = runDatabaseBudgetCommand(source(path), ["--ready"], {
      now: time.now,
      deadline: time.deadline,
      open: (options) => {
        opens++;
        return over(
          () => {
            throw new Error("Private operations Node bridge exited");
          },
          // The deadline passes while the dead bridge closes.
          () => time.expire(),
        )(options);
      },
    });
    await assert.rejects(run, (error) => {
      assert.ok(error instanceof DatabaseBudgetFailure);
      assert.equal(error.receipt.outcome, "readiness-error");
      return true;
    });
    assert.equal(opens, 1, "nothing starts after the deadline");
  });
});
