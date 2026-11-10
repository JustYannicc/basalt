import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import { stateProvisioningStore } from "./provisioning-state.ts";
import { provisioningJournal } from "./provisioning-journal.ts";
import { journalKey, readForwardJournal } from "./forward-journal.ts";

const scope = { name: "synthetic", stage: "production" },
  key = "a".repeat(64);
const candidate = "b".repeat(40),
  manifest = "c".repeat(64),
  request = "d".repeat(64);

test("provisioning retains encrypted recovery and the preceding completed legacy journal", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InMemoryService();
      const previous = {
        schemaVersion: 1,
        candidate: "e".repeat(40),
        manifest: "f".repeat(64),
        sealed: { synthetic: true },
        complete: true,
      };
      yield* state.setOutput({ ...journalKey(scope), value: previous });
      const store = stateProvisioningStore(state, scope, key, (work) => work());
      const journal = provisioningJournal(store, candidate, manifest);
      const result = { privateBaseline: "synthetic-secret-setting" };
      yield* Effect.promise(() =>
        journal.once(
          "namespace-baseline",
          request,
          async () => result,
          (value) => {
            assert.deepEqual(value, result);
            return result;
          },
        ),
      );
      const retained = yield* state.getOutput(journalKey(scope));
      assert.equal(JSON.stringify(retained).includes("synthetic-secret-setting"), false);
      assert.deepEqual(
        (yield* Effect.promise(() => journal.read())).operations["namespace-baseline"]!.result,
        result,
      );
      assert.deepEqual(
        typeof retained === "object" && retained && "previous" in retained
          ? retained.previous
          : undefined,
        previous,
      );
      const read = readForwardJournal(scope, key).pipe(
        Effect.provideService(State, Effect.succeed(state)),
      );
      yield* Effect.promise(() =>
        assert.rejects(Effect.runPromise(read), /runtime-provisioning-journal-unsettled/),
      );
    }),
  );
});

test("an incomplete legacy release refuses provisioning before any operation", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InMemoryService();
      yield* state.setOutput({
        ...journalKey(scope),
        value: { schemaVersion: 1, complete: false },
      });
      const store = stateProvisioningStore(state, scope, key, (work) => work());
      let sends = 0;
      yield* Effect.promise(() =>
        assert.rejects(
          provisioningJournal(store, candidate, manifest).once(
            "create",
            request,
            async () => {
              sends++;
              return "synthetic";
            },
            String,
          ),
          /provisioning-prior-release-unsettled/,
        ),
      );
      assert.equal(sends, 0);
    }),
  );
});

test("a verified settlement retains its receipt and permits a separately enabled next manifest", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InMemoryService();
      const store = stateProvisioningStore(state, scope, key, (work) => work());
      const first = provisioningJournal(store, candidate, manifest);
      yield* Effect.promise(() =>
        first.once("synthetic-proof", request, async () => "verified", String),
      );
      const receipt = "1".repeat(64);
      yield* Effect.promise(() => first.finish(receipt));
      assert.equal((yield* Effect.promise(() => first.read())).receipt, receipt);
      assert.equal(
        (yield* readForwardJournal(scope, key).pipe(
          Effect.provideService(State, Effect.succeed(state)),
        ))?.complete,
        true,
      );
      const second = provisioningJournal(store, candidate, "2".repeat(64));
      yield* Effect.promise(() =>
        second.once("next-phase", request, async () => "new-proof", String),
      );
      const current = yield* state.getOutput(journalKey(scope));
      assert.equal(
        typeof current === "object" &&
          current &&
          "previous" in current &&
          typeof current.previous === "object" &&
          current.previous &&
          "complete" in current.previous
          ? current.previous.complete
          : undefined,
        true,
      );
      yield* Effect.promise(() =>
        assert.rejects(
          first.once("synthetic-proof", request, async () => "must-not-run", String),
          /provisioning-input-drift/,
        ),
      );
    }),
  );
});

test("changing only the public complete flag cannot settle an uncertain private packet", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InMemoryService();
      const store = stateProvisioningStore(state, scope, key, (work) => work());
      const journal = provisioningJournal(store, candidate, manifest);
      yield* Effect.promise(() =>
        assert.rejects(
          journal.once(
            "create",
            request,
            async () => {
              throw new Error("Lost response");
            },
            String,
          ),
          /provisioning-operation-unknown/,
        ),
      );
      yield* Effect.promise(() =>
        assert.rejects(journal.finish("1".repeat(64)), /provisioning-operation-unknown/),
      );
      const current = yield* state.getOutput(journalKey(scope));
      assert.ok(current && typeof current === "object");
      yield* state.setOutput({ ...journalKey(scope), value: { ...current, complete: true } });
      yield* Effect.promise(() =>
        assert.rejects(
          Effect.runPromise(
            readForwardJournal(scope, key).pipe(
              Effect.provideService(State, Effect.succeed(state)),
            ),
          ),
          /provisioning-input-drift/,
        ),
      );
    }),
  );
});
