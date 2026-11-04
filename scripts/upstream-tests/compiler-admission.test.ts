import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Clock, Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { BuildBusy, RuntimeBuildFailed } from "../../.upstream/packages/sdk/src/core.ts";
import { makeBuildAdmission } from "../../.upstream/apps/hosted/cloud/src/implementation/build-admission.ts";
import {
  compileWithinDeadline,
  requestCompile,
} from "../../.upstream/apps/hosted/cloud/src/implementation/compiler-request.ts";

type Advance = (milliseconds: number) => Effect.Effect<void>;
const run = (context: TestContext, program: (advance: Advance) => Effect.Effect<void, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      // Keep persistent lease time aligned with the controlled request timers.
      context.mock.method(Date, "now", () => clock.currentTimeMillisUnsafe());
      yield* program((milliseconds) => TestClock.adjust(milliseconds));
    }).pipe(Effect.provide(TestClock.layer())),
  );
const compile = <A>(admission: ReturnType<typeof makeBuildAdmission>, work: Effect.Effect<A>) =>
  requestCompile(admission(compileWithinDeadline(work)));
const occupy = (admission: ReturnType<typeof makeBuildAdmission>) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fiber = yield* admission(
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    return { release, fiber };
  });

test("40 seconds queued leave the admitted compile its full 50-second budget", (context) =>
  run(context, (advance) =>
    Effect.gen(function* () {
      const admission = makeBuildAdmission(1, "50 seconds");
      const occupying = yield* occupy(admission);
      const waiting = yield* compile(
        admission,
        Effect.sleep("20 seconds").pipe(Effect.as("compiled")),
      ).pipe(Effect.forkChild);
      yield* advance(40_000);
      yield* Deferred.succeed(occupying.release, undefined);
      yield* Fiber.join(occupying.fiber);
      yield* advance(200);
      yield* advance(20_000);
      assert.equal(yield* Fiber.join(waiting), "compiled");
    }),
  ));

test("queue wait beyond 50 seconds reports busy without starting a compile", (context) =>
  run(context, (advance) =>
    Effect.gen(function* () {
      const admission = makeBuildAdmission(1, "50 seconds");
      const occupying = yield* occupy(admission);
      let compiled = false;
      const waiting = yield* compile(
        admission,
        Effect.sync(() => {
          compiled = true;
        }),
      ).pipe(Effect.result, Effect.forkChild);
      yield* advance(50_001);
      const result = yield* Fiber.join(waiting);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.ok(Schema.is(BuildBusy)(result.failure));
      assert.equal(compiled, false);
      yield* Deferred.succeed(occupying.release, undefined);
      yield* Fiber.join(occupying.fiber);
    }),
  ));

test("an admitted compiler that never answers still fails at 50 seconds", (context) =>
  run(context, (advance) =>
    Effect.gen(function* () {
      const admission = makeBuildAdmission(1, "50 seconds");
      const compiling = yield* compile(admission, Effect.never).pipe(
        Effect.result,
        Effect.forkChild,
      );
      yield* advance(50_000);
      const result = yield* Fiber.join(compiling);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.ok(Schema.is(RuntimeBuildFailed)(result.failure));
        assert.equal(result.failure.unanswered, true);
        assert.match(result.failure.message ?? "", /within 50 seconds/);
      }
    }),
  ));

test("a lost RPC is bounded by the sum of the queue and compile budgets", (context) =>
  run(context, (advance) =>
    Effect.gen(function* () {
      const request = yield* requestCompile(Effect.never).pipe(Effect.result, Effect.forkChild);
      yield* advance(100_000);
      const result = yield* Fiber.join(request);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.ok(Schema.is(RuntimeBuildFailed)(result.failure));
    }),
  ));

test("a late admission gets a full lease from its grant", (context) =>
  run(context, (advance) =>
    Effect.gen(function* () {
      const admission = makeBuildAdmission(1, "50 seconds");
      const first = yield* occupy(admission);
      const secondStarted = yield* Deferred.make<void>();
      const secondRelease = yield* Deferred.make<void>();
      const second = yield* admission(
        Deferred.succeed(secondStarted, undefined).pipe(
          Effect.andThen(Deferred.await(secondRelease)),
        ),
      ).pipe(Effect.forkChild);
      yield* advance(40_000);
      yield* Deferred.succeed(first.release, undefined);
      yield* Fiber.join(first.fiber);
      yield* advance(200);
      yield* Deferred.await(secondStarted);
      let thirdStarted = false;
      const third = yield* admission(
        Effect.sync(() => {
          thirdStarted = true;
        }),
      ).pipe(Effect.forkChild);
      yield* advance(11_000);
      assert.equal(thirdStarted, false, "lease starts at admission rather than enqueue");
      yield* Deferred.succeed(secondRelease, undefined);
      yield* Fiber.join(second);
      yield* advance(200);
      yield* Fiber.join(third);
      assert.equal(thirdStarted, true);
    }),
  ));

test("queued requests keep their FIFO position in one RPC call each", (context) =>
  run(context, (advance) =>
    Effect.gen(function* () {
      const admission = makeBuildAdmission(1, "50 seconds");
      const first = yield* occupy(admission);
      const order: string[] = [];
      let olderRequests = 0,
        newerRequests = 0;
      const older = yield* requestCompile(
        Effect.suspend(() => {
          olderRequests++;
          return admission(
            compileWithinDeadline(
              Effect.sync(() => {
                order.push("older");
              }),
            ),
          );
        }),
      ).pipe(Effect.forkChild);
      yield* advance(200);
      const newer = yield* requestCompile(
        Effect.suspend(() => {
          newerRequests++;
          return admission(
            compileWithinDeadline(
              Effect.sync(() => {
                order.push("newer");
              }),
            ),
          );
        }),
      ).pipe(Effect.forkChild);
      yield* advance(200);
      yield* Deferred.succeed(first.release, undefined);
      yield* Fiber.join(first.fiber);
      yield* advance(200);
      yield* Fiber.join(older);
      yield* advance(200);
      yield* Fiber.join(newer);
      assert.deepEqual(order, ["older", "newer"]);
      assert.equal(olderRequests, 1);
      assert.equal(newerRequests, 1);
    }),
  ));

test("client cancellation releases its queued FIFO ticket", (context) =>
  run(context, (advance) =>
    Effect.gen(function* () {
      const admission = makeBuildAdmission(1, "50 seconds");
      const occupying = yield* occupy(admission);
      let compiledAfterDisconnect = false;
      const waiting = yield* compile(
        admission,
        Effect.sync(() => {
          compiledAfterDisconnect = true;
        }),
      ).pipe(Effect.forkChild);
      yield* advance(200);
      yield* Fiber.interrupt(waiting);
      yield* Deferred.succeed(occupying.release, undefined);
      yield* Fiber.join(occupying.fiber);
      const next = yield* compile(admission, Effect.succeed("next")).pipe(Effect.forkChild);
      yield* advance(200);
      assert.equal(yield* Fiber.join(next), "next");
      assert.equal(compiledAfterDisconnect, false);
    }),
  ));
