import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import * as Cloudflare from "alchemy/Cloudflare";
import { Cause, ConfigProvider, Effect, Exit, Redacted, Schema } from "effect";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const upstreamRoot = resolve(process.env.BASALT_UPSTREAM_ROOT ?? join(projectRoot, ".upstream"));
const [workflow, workflowContracts, workflowErrors] = await Promise.all([
  import(
    pathToFileURL(resolve(upstreamRoot, "apps/hosted/cloud/src/infrastructure/workflow-results.ts"))
      .href
  ),
  import(pathToFileURL(resolve(upstreamRoot, "packages/apps/src/contracts/workflows.ts")).href),
  import(
    pathToFileURL(resolve(upstreamRoot, "packages/sdk/src/contracts/workflow-errors.ts")).href
  ),
]);
const { encryptedWorkflowResult, encryptedWorkflowTask, workflowEncryptionKey, workflowResults } =
  workflow;
const { WorkflowFailure } = workflowContracts;
const { decodeWorkflowFailure, workflowFailureMessage } = workflowErrors;

const firstKey = "31".repeat(32);
const secondKey = "72".repeat(32);

type PersistedWorkflowFailure = {
  readonly message: string;
  readonly retryable: boolean;
  readonly kind: "fail" | "die";
  readonly failure?: string;
};

const runWithKeyExit = <A, E>(key: string, effect: Effect.Effect<A, E, unknown>) => {
  const configured = effect.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({
        env: { EXECUTOR_ENCRYPTION_KEY: key, EXECUTOR_ENCRYPTED_WORKFLOW_STARTS: "true" },
      }),
    ),
    Effect.provideService(
      Cloudflare.WorkerEnvironment,
      Cloudflare.WorkerEnvironment.of({ EXECUTOR_ENCRYPTION_KEY: key }),
    ),
  );
  // Runtime-loaded upstream modules erase the environment type; the fixture provides its services above.
  return Effect.runPromiseExit(configured as Effect.Effect<A, E>);
};

const runWithKey = async <A, E>(key: string, effect: Effect.Effect<A, E, unknown>): Promise<A> => {
  const exit = await runWithKeyExit(key, effect);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
};

const makeResults = (run: string) =>
  Effect.gen(function* () {
    const encryptionKey = yield* workflowEncryptionKey;
    return yield* workflowResults(run, encryptionKey);
  });

const makeJournal = () => {
  const entries = new Map<
    string,
    | { readonly kind: "value"; readonly value: Uint8Array }
    | { readonly kind: "failure"; readonly cause: "fail" | "die"; readonly message: string }
  >();
  const accessOrder: string[] = [];
  let executions = 0;
  const service = Cloudflare.Workflows.WorkflowStep.of({
    do: <A, E>(
      options: Cloudflare.Workflows.WorkflowTaskOptions<A, any, any, E>,
    ): Effect.Effect<A, E> => {
      const journalEffect = Effect.gen(function* () {
        accessOrder.push(options.name);
        const existing = entries.get(options.name);
        if (existing?.kind === "value") return Uint8Array.from(existing.value) as A;
        if (existing?.kind === "failure") {
          const error = new Error(existing.message);
          return yield* existing.cause === "fail" ? Effect.fail(error as E) : Effect.die(error);
        }

        executions++;
        const exit = yield* Effect.exit(options.effect);
        if (Exit.isSuccess(exit)) {
          assert.ok(exit.value instanceof Uint8Array, "the journal only receives encrypted bytes");
          const value = Uint8Array.from(exit.value);
          entries.set(options.name, { kind: "value", value });
          return value as A;
        }

        const error = Cause.squash(exit.cause);
        entries.set(options.name, {
          kind: "failure",
          cause: Cause.hasDies(exit.cause) ? "die" : "fail",
          message: error instanceof Error ? error.message : String(error),
        });
        return yield* Effect.failCause(exit.cause);
      });
      // WorkflowStep runs the stored effect with its caller's context, matching the upstream service contract.
      return journalEffect as Effect.Effect<A, E>;
    },
    sleep: () => Effect.void,
    sleepUntil: () => Effect.void,
    waitForEvent: () => Effect.die(new Error("The test does not call waitForEvent")),
  });
  return {
    entries,
    accessOrder,
    service,
    get executions() {
      return executions;
    },
  };
};

const runStep = (
  results: typeof workflowResults extends (...args: never[]) => Effect.Effect<infer A> ? A : never,
  journal: ReturnType<typeof makeJournal>,
  name: string,
  work: () => Effect.Effect<unknown, unknown>,
) =>
  encryptedWorkflowTask({
    results,
    name,
    options: { retries: { limit: 0, delay: 0 } },
    work,
    encodeFailure: (error: unknown) =>
      workflowFailureMessage(
        Schema.is(WorkflowFailure)(error) ? error : decodeWorkflowFailure(error),
      ),
    isRetryable: (error: unknown) => (Schema.is(WorkflowFailure)(error) ? error.retryable : true),
    restoreFailure: (failure: PersistedWorkflowFailure) =>
      decodeWorkflowFailure(new Error(failure.message)),
  }).pipe(Effect.provideService(Cloudflare.Workflows.WorkflowStep, journal.service));

test("persists ciphertext and replays a step without executing its callback again", async () => {
  const journal = makeJournal();
  const privateValue = "private-step-value-fixture";
  const execute = (key: string) =>
    Effect.gen(function* () {
      const results = yield* makeResults("wfr_step_fixture");
      return yield* runStep(results, journal, "step with private label", () =>
        Effect.sync(() => ({ value: privateValue })),
      );
    });

  assert.deepEqual(await runWithKey(firstKey, execute(firstKey)), { value: privateValue });
  assert.equal(journal.executions, 1);
  assert.equal(journal.entries.size, 1);
  const persisted = [...journal.entries.values()][0];
  assert.equal(persisted?.kind, "value");
  if (persisted?.kind !== "value") assert.fail("expected a persisted ciphertext");
  assert.ok(persisted.value instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(persisted.value).includes(privateValue), false);
  assert.equal(
    [...journal.entries.keys()].some((name) => name.includes("private label")),
    false,
  );

  assert.deepEqual(await runWithKey(firstKey, execute(firstKey)), { value: privateValue });
  assert.equal(
    journal.executions,
    1,
    "replay must return the saved ciphertext without re-running work",
  );
});

test("parallel branch replay keeps per-name journal identities when completion order changes", async () => {
  const journal = makeJournal();
  const executed: string[] = [];
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => (releaseA = resolve));
  let releaseReplayB!: () => void;
  const gateReplayB = new Promise<void>((resolve) => (releaseReplayB = resolve));
  const makeInvocation = (completionOrder: string[], replay = false) =>
    Effect.gen(function* () {
      const results = yield* makeResults("wfr_parallel_fixture");
      const task = (name: string) =>
        (replay && name === "B" ? Effect.promise(() => gateReplayB) : Effect.void).pipe(
          Effect.andThen(
            runStep(results, journal, name, () =>
              Effect.sync(() => executed.push(name)).pipe(
                Effect.andThen(name === "A" ? Effect.promise(() => gateA) : Effect.void),
                Effect.as({ name }),
              ),
            ),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              completionOrder.push(name);
              if (name === "D") releaseA();
              if (replay && name === "C") releaseReplayB();
            }),
          ),
        );
      return yield* Effect.all(
        [
          task("A").pipe(Effect.flatMap(() => task("C"))),
          task("B").pipe(Effect.flatMap(() => task("D"))),
        ],
        { concurrency: "unbounded" },
      );
    });

  const firstOrder: string[] = [];
  const first = await runWithKey(firstKey, makeInvocation(firstOrder));
  assert.deepEqual(firstOrder, ["B", "D", "A", "C"]);
  assert.equal(journal.executions, 4);
  assert.equal(executed.length, 4);
  const replayOrder: string[] = [];
  const replay = await runWithKey(firstKey, makeInvocation(replayOrder, true));
  assert.deepEqual(replayOrder, ["A", "C", "B", "D"]);
  assert.notDeepEqual(replayOrder, firstOrder);
  assert.ok(Array.isArray(first));
  assert.ok(Array.isArray(replay));
  const namedEntry = (value: unknown): [string, unknown] => {
    assert.ok(typeof value === "object" && value !== null && "name" in value);
    assert.ok(typeof value.name === "string");
    return [value.name, value];
  };
  assert.deepEqual(
    Object.fromEntries(replay.map(namedEntry)),
    Object.fromEntries(first.map(namedEntry)),
  );
  assert.equal(
    journal.executions,
    4,
    "cached C and D must not run again after branch order changes",
  );
  assert.equal(executed.length, 4);
  assert.equal(journal.entries.size, 4);
  assert.equal(new Set(journal.accessOrder).size, 4);
});

test("retryable and non-retryable callback errors stay encrypted and decode on replay", async () => {
  for (const retryable of [true, false]) {
    const journal = makeJournal();
    const message = `private callback exception ${retryable}`;
    const original = new WorkflowFailure({
      reason: "execution",
      retryable,
      errorName: "SyntheticCallbackError",
      message,
    });
    const execute = () =>
      Effect.gen(function* () {
        const results = yield* makeResults(`wfr_failure_${retryable}`);
        return yield* runStep(results, journal, "callback", () => Effect.fail(original));
      });

    const first = await runWithKeyExit(firstKey, execute());
    assert.ok(Exit.isFailure(first));
    assert.equal(journal.executions, 1);
    const persisted = [...journal.entries.values()][0];
    assert.equal(persisted?.kind, "failure");
    if (persisted?.kind !== "failure") assert.fail("expected encrypted failure metadata");
    assert.match(persisted.message, /^ExecutorEncryptedWorkflowFailure\(v1\):[0-9a-f]+$/i);
    assert.equal(persisted.message.includes(message), false);

    const replay = await runWithKeyExit(firstKey, execute());
    assert.ok(Exit.isFailure(replay));
    const restored = Cause.squash(replay.cause);
    assert.ok(Schema.is(WorkflowFailure)(restored));
    assert.equal(restored.retryable, retryable);
    assert.equal(restored.reason, "execution");
    assert.equal(restored.errorName, "SyntheticCallbackError");
    assert.equal(restored.message, message);
    assert.equal(journal.executions, 1);

    if (retryable) {
      journal.entries.set([...journal.entries.keys()][0]!, {
        kind: "failure",
        cause: "fail",
        message: "ExecutorEncryptedWorkflowFailure(v1):01",
      });
      const truncated = await runWithKeyExit(firstKey, execute());
      assert.ok(Exit.isFailure(truncated));
      const rejected = Cause.squash(truncated.cause);
      assert.ok(Schema.is(WorkflowFailure)(rejected));
      assert.equal(rejected.retryable, false);
      assert.equal(rejected.reason, "engine");
      assert.equal(journal.executions, 1);
    }
  }
});

test("a defect or non-retryable failure stops a mixed-cause step on first execution and replay", async () => {
  for (const secondReason of ["defect", "non-retryable failure"]) {
    const journal = makeJournal();
    const retryable = new WorkflowFailure({ reason: "execution", retryable: true });
    const other =
      secondReason === "defect"
        ? Cause.die(new Error("private mixed-cause defect fixture"))
        : Cause.fail(new WorkflowFailure({ reason: "execution", retryable: false }));
    const cause = Cause.combine(Cause.fail(retryable), other);
    const execute = () =>
      Effect.gen(function* () {
        const results = yield* makeResults(`wfr_mixed_${secondReason}`);
        return yield* runStep(results, journal, "mixed cause", () => Effect.failCause(cause));
      });

    const first = await runWithKeyExit(firstKey, execute());
    assert.ok(Exit.isFailure(first));
    const persisted = [...journal.entries.values()][0];
    assert.equal(persisted?.kind, "failure");
    if (persisted?.kind !== "failure") assert.fail("expected an encrypted mixed failure");
    assert.equal(persisted.cause, "die", `${secondReason} must stop native retries`);
    assert.equal(persisted.message.includes("private mixed-cause"), false);
    const replay = await runWithKeyExit(firstKey, execute());
    assert.ok(Exit.isFailure(replay));
    assert.equal(Cause.hasDies(replay.cause), true);
    assert.equal(journal.executions, 1);
  }
});

test("wrong keys and tampered or truncated ciphertext fail closed without re-running callbacks", async () => {
  const journal = makeJournal();
  let calls = 0;
  const execute = (key: string) =>
    Effect.gen(function* () {
      const results = yield* makeResults("wfr_tamper_fixture");
      return yield* runStep(results, journal, "secret step", () =>
        Effect.sync(() => {
          calls++;
          return { value: "private-tamper-fixture" };
        }),
      );
    });

  await runWithKey(firstKey, execute(firstKey));
  assert.equal(calls, 1);
  const saved = [...journal.entries.values()][0];
  assert.equal(saved?.kind, "value");
  if (saved?.kind !== "value") assert.fail("expected ciphertext");

  const wrongKey = await runWithKeyExit(secondKey, execute(secondKey));
  assert.ok(Exit.isFailure(wrongKey));
  const wrongKeyFailure = Cause.squash(wrongKey.cause);
  assert.ok(Schema.is(WorkflowFailure)(wrongKeyFailure));
  assert.equal(wrongKeyFailure.retryable, false);
  assert.equal(calls, 1);

  const tampered = Uint8Array.from(saved.value);
  tampered[tampered.length - 1] ^= 1;
  journal.entries.set([...journal.entries.keys()][0]!, { kind: "value", value: tampered });
  const badCiphertext = await runWithKeyExit(firstKey, execute(firstKey));
  assert.ok(Exit.isFailure(badCiphertext));
  const tamperFailure = Cause.squash(badCiphertext.cause);
  assert.ok(Schema.is(WorkflowFailure)(tamperFailure));
  assert.equal(tamperFailure.retryable, false);
  assert.equal(calls, 1);

  const truncated = saved.value.slice(0, -1);
  assert.ok(truncated.length < saved.value.length);
  journal.entries.set([...journal.entries.keys()][0]!, { kind: "value", value: truncated });
  const truncatedCiphertext = await runWithKeyExit(firstKey, execute(firstKey));
  assert.ok(Exit.isFailure(truncatedCiphertext));
  const truncationFailure = Cause.squash(truncatedCiphertext.cause);
  assert.ok(Schema.is(WorkflowFailure)(truncationFailure));
  assert.equal(truncationFailure.retryable, false);
  assert.equal(calls, 1);
});

test("the Workflow's final returned value is ciphertext and can be decoded by the status reader", async () => {
  const privateValue = "private-final-output-fixture";
  const encrypted = await runWithKey(
    firstKey,
    Effect.gen(function* () {
      const results = yield* makeResults("wfr_final_fixture");
      return yield* encryptedWorkflowResult({
        results,
        work: Effect.succeed({ value: privateValue }),
        encodeFailure: String,
        isRetryable: () => false,
      });
    }),
  );
  assert.ok(encrypted instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(encrypted).includes(privateValue), false);
  const decoded = await runWithKey(
    firstKey,
    Effect.gen(function* () {
      const results = yield* makeResults("wfr_final_fixture");
      return yield* results.openWorkflowOutput(encrypted);
    }),
  );
  assert.deepEqual(decoded, { value: privateValue });
});

test("final failure messages and retryability stay encrypted", async () => {
  for (const retryable of [true, false]) {
    const message = `private final failure ${retryable}`;
    const original = new WorkflowFailure({
      reason: "execution",
      retryable,
      errorName: "SyntheticFinalError",
      message,
    });
    const { result, failure } = await runWithKey(
      firstKey,
      Effect.gen(function* () {
        const results = yield* makeResults(`wfr_final_failure_${retryable}`);
        const exit = yield* Effect.exit(
          encryptedWorkflowResult({
            results,
            work: Effect.fail(original),
            encodeFailure: (error: unknown) =>
              workflowFailureMessage(
                Schema.is(WorkflowFailure)(error) ? error : decodeWorkflowFailure(error),
              ),
            isRetryable: (error: unknown) =>
              Schema.is(WorkflowFailure)(error) ? error.retryable : true,
          }),
        );
        assert.ok(Exit.isFailure(exit));
        const error = Cause.squash(exit.cause);
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(message), false);
        const opened = yield* results.openWorkflowFailure(error);
        return { result: error.message, failure: opened.value };
      }),
    );
    assert.match(result, /^ExecutorEncryptedWorkflowRunFailure\(v1\):[0-9a-f]+$/i);
    assert.equal(failure.retryable, retryable);
    const restored = decodeWorkflowFailure(new Error(failure.message));
    assert.equal(restored.reason, "execution");
    assert.equal(restored.retryable, retryable);
    assert.equal(restored.errorName, "SyntheticFinalError");
    assert.equal(restored.message, message);
  }
});

test("sleep checkpoint names hide app supplied strings", async () => {
  const privateName = "private sleep name fixture";
  const storedName = await runWithKey(
    firstKey,
    Effect.gen(function* () {
      const results = yield* makeResults("wfr_sleep_fixture");
      return yield* results.storedStepName(privateName);
    }),
  );
  assert.equal(String(storedName).includes(privateName), false);
});

test("same-name parallel checkpoints cannot replay another branch's result", async () => {
  const journal = makeJournal();
  const execute = (order: string[]) =>
    Effect.gen(function* () {
      const results = yield* makeResults("wfr_same_name_parallel");
      return yield* Effect.all(
        order.map((label) =>
          runStep(results, journal, "same native name", () => Effect.succeed(label)).pipe(
            Effect.map((value) => ({ label, value })),
          ),
        ),
        { concurrency: "unbounded" },
      );
    });
  const cold = await runWithKeyExit(firstKey, execute(["A", "B"]));
  if (Exit.isFailure(cold)) {
    const failure = Cause.squash(cold.cause);
    assert.ok(Schema.is(WorkflowFailure)(failure));
    assert.equal(failure.reason, "engine");
    assert.equal(failure.retryable, false);
    return;
  }
  const replay = await runWithKey(firstKey, execute(["B", "A"]));
  assert.deepEqual(
    replay,
    [
      { label: "B", value: "B" },
      { label: "A", value: "A" },
    ],
    "same-name replay swapped the branches' saved values",
  );
});

test("a newly created encrypted run rejects a plaintext replacement output", async () => {
  const { cloudWorkflows } = await import(
    pathToFileURL(resolve(upstreamRoot, "apps/hosted/cloud/src/infrastructure/workflow-runtime.ts"))
      .href
  );
  const run = "wfr_plaintext_replacement";
  const instances = new Map<string, unknown>();
  let created: { id?: string; params?: unknown } | undefined;
  const native = {
    create: async (options: { id: string; params: unknown }) => {
      created = options;
      instances.set(options.id, { status: "complete", output: { forged: true } });
      return { id: options.id };
    },
    get: async (id: string) => ({ status: async () => instances.get(id) ?? { status: "unknown" } }),
  };
  const program = Effect.gen(function* () {
    const runtime = yield* cloudWorkflows;
    yield* runtime.start(run as never);
    return yield* runtime.status(run as never);
  }).pipe(
    Effect.provideService(
      Cloudflare.WorkerEnvironment,
      Cloudflare.WorkerEnvironment.of({ EXECUTOR_ENCRYPTION_KEY: firstKey, AppWorkflows: native }),
    ),
  );
  const exit = await runWithKeyExit(firstKey, program);
  assert.ok(
    created &&
      typeof created.params === "object" &&
      created.params !== null &&
      "__executorWorkflowResults" in created.params,
  );
  assert.ok(
    Exit.isFailure(exit),
    "marked run accepted forged plaintext as a successful completed output",
  );
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    assert.ok(Schema.is(WorkflowFailure)(error));
    assert.equal(error.reason, "engine");
    assert.equal(error.retryable, false);
  }
});

test("status decodes new ciphertext, preserves old JSON, and terminates the actual native instance", async () => {
  const { cloudWorkflows } = await import(
    pathToFileURL(resolve(upstreamRoot, "apps/hosted/cloud/src/infrastructure/workflow-runtime.ts"))
      .href
  );
  const run = "wfr_new_ciphertext";
  const oldRun = "wfr_old_plaintext";
  const instances = new Map<string, unknown>([
    [oldRun, { status: "complete", output: { legacy: true } }],
  ]);
  let created: string | undefined;
  let terminated: string | undefined;
  const native = {
    create: async (options: { id: string; params: unknown }) => {
      created = options.id;
      instances.set(options.id, { status: "running" });
      return { id: options.id };
    },
    get: async (id: string) => ({
      status: async () => instances.get(id) ?? { status: "unknown" },
      terminate: async () => {
        terminated = id;
        instances.set(id, { status: "terminated" });
      },
    }),
  };
  const program = Effect.gen(function* () {
    const runtime = yield* cloudWorkflows;
    yield* runtime.start(run as never);
    assert.ok(created);
    yield* runtime.terminate(run as never);
    assert.equal(terminated, created);
    const results = yield* makeResults(run);
    instances.set(created, {
      status: "complete",
      output: yield* results.sealWorkflowOutput({ secure: true }),
    });
    const freshRuntime = yield* cloudWorkflows;
    assert.deepEqual(yield* freshRuntime.status(run as never), {
      status: "complete",
      output: { secure: true },
    });
    assert.deepEqual(yield* freshRuntime.status(oldRun as never), {
      status: "complete",
      output: { legacy: true },
    });
  }).pipe(
    Effect.provideService(
      Cloudflare.WorkerEnvironment,
      Cloudflare.WorkerEnvironment.of({ EXECUTOR_ENCRYPTION_KEY: firstKey, AppWorkflows: native }),
    ),
  );
  await runWithKey(firstKey, program);
});

test("the disabled cutover gate shares the legacy native identity with old dispatchers", async () => {
  const { cloudWorkflows } = await import(
    pathToFileURL(resolve(upstreamRoot, "apps/hosted/cloud/src/infrastructure/workflow-runtime.ts"))
      .href
  );
  const run = "wfr_cutover_race";
  const instances = new Map<string, { status: string }>();
  const created: { id: string; params: unknown }[] = [];
  const native = {
    get: async (id: string) => ({ status: async () => instances.get(id) ?? { status: "unknown" } }),
    create: async (options: { id: string; params: unknown }) => {
      assert.ok(!instances.has(options.id));
      created.push(options);
      instances.set(options.id, { status: "running" });
      return { id: options.id };
    },
  };
  const program = Effect.gen(function* () {
    const current = yield* cloudWorkflows;
    yield* current.start(run as never);
    // The base runtime checks and creates the public run ID directly.
    if (
      (yield* Effect.promise(async () => await (await native.get(run)).status())).status ===
      "unknown"
    )
      yield* Effect.promise(() => native.create({ id: run, params: { run } }));
  }).pipe(
    Effect.provideService(
      Cloudflare.WorkerEnvironment,
      Cloudflare.WorkerEnvironment.of({ EXECUTOR_ENCRYPTION_KEY: firstKey, AppWorkflows: native }),
    ),
  );
  const configured = program.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: { EXECUTOR_ENCRYPTION_KEY: firstKey } }),
    ),
  );
  await Effect.runPromise(configured as Effect.Effect<void>);
  assert.equal(
    created.length,
    1,
    "old and new dispatchers created two native instances for one run",
  );
  assert.equal(created[0]?.id, run);
  assert.deepEqual(created[0]?.params, { run });
});
