import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber } from "../../.upstream/node_modules/effect/dist/index.js";
import {
  AppCodeId,
  SourceCommit,
  SourceError,
  type RepositoryBackend,
} from "../../.upstream/packages/sdk/src/core.ts";
import { sourceWriteFence } from "../../.upstream/apps/hosted/cloud/src/implementation/source-write-fence.ts";

const code = AppCodeId.make("code_frontier-proof");
const commit = SourceCommit.make("a".repeat(40));
const saved = { commit, removed: { count: 0, paths: [] } };
const unavailable = () => Effect.fail(new SourceError({ reason: "not-found" }));
const repository = (overrides: Partial<RepositoryBackend>): RepositoryBackend => ({
  history: () => Effect.succeed([]),
  create: () => Effect.void,
  head: () => Effect.succeed(null),
  read: unavailable,
  commit: () => Effect.succeed(saved),
  blob: unavailable,
  file: unavailable,
  request: () => Effect.succeed(new Response("0000")),
  ...overrides,
});
const input = { id: code, branch: "main", expected: commit, files: [], message: "Save" };

const admission = () => {
  const state = { active: 0, retired: false };
  return {
    state,
    begin: () =>
      Effect.gen(function* () {
        if (state.retired) return yield* new SourceError({ reason: "conflict" });
        state.active += 1;
      }),
    complete: () =>
      Effect.sync(() => {
        state.active -= 1;
      }),
  };
};

test("a pending Git write does not block another source save", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const frontier = admission();
        const api = sourceWriteFence(
          repository({
            create: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          }),
          frontier,
        );
        const pending = yield* api.create(code).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        assert.equal(frontier.state.active, 1);
        assert.deepEqual(yield* api.commit(input), saved);
        assert.equal(frontier.state.active, 1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
        assert.equal(frontier.state.active, 0);
      }),
    ),
  );
});

test("Git receive-pack remains active until its full report arrives", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const frontier = admission();
        let report: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            report = controller;
          },
        });
        const api = sourceWriteFence(
          repository({
            request: () =>
              Deferred.succeed(started, undefined).pipe(Effect.as(new Response(stream))),
          }),
          frontier,
        );
        const pending = yield* api
          .request(
            code,
            new Request("https://git.example.test/git-receive-pack", {
              method: "POST",
              body: "0000",
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        assert.equal(frontier.state.active, 1);
        assert.ok(report);
        report.enqueue(new TextEncoder().encode("complete report"));
        report.close();
        const response = yield* Fiber.join(pending);
        assert.equal(yield* Effect.promise(() => response.text()), "complete report");
        assert.equal(frontier.state.active, 0);
      }),
    ),
  );
});

test("a failed or interrupted write stays uncertain while later saves proceed", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const frontier = admission();
        const failed = sourceWriteFence(
          repository({ create: () => Effect.fail(new SourceError({ reason: "git" })) }),
          frontier,
        );
        assert.equal((yield* Effect.exit(failed.create(code)))._tag, "Failure");
        const interrupted = sourceWriteFence(
          repository({
            create: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
          }),
          frontier,
        );
        const pending = yield* interrupted.create(code).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(pending);
        assert.equal(frontier.state.active, 2);
        assert.deepEqual(yield* failed.commit(input), saved);
        assert.equal(frontier.state.active, 2);
      }),
    ),
  );
});

test("a retired lineage rejects new writes before touching Git and retains reads", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const frontier = admission();
      frontier.state.retired = true;
      let writes = 0;
      const api = sourceWriteFence(
        repository({
          create: () =>
            Effect.sync(() => {
              writes += 1;
            }),
        }),
        frontier,
      );
      assert.equal((yield* Effect.exit(api.create(code)))._tag, "Failure");
      assert.equal(writes, 0);
      assert.equal(frontier.state.active, 0);
      assert.deepEqual(yield* api.history(code), []);
      assert.equal(
        (yield* api.request(code, new Request("https://git.example.test/info/refs"))).status,
        200,
      );
    }),
  );
});
