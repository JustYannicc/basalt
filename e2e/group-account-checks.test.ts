import assert from "node:assert/strict";
import { test } from "node:test";
import { Deferred, Effect, Fiber, Schema } from "effect";
import {
  AccountAcquisitionUnavailable,
  AccountGroupCheck,
  AccountGroupCheckResult,
  AccountId,
  AccountNotFound,
  StorageError,
  checkEach,
} from "@executor-js/sdk/core";

const ids = ["healthy", "missing", "storage", "acquisition"].map((name) =>
  AccountId.make(`acc_${name}`),
);
const health = (account: AccountId) => ({ account, info: null, infoCheckedAt: null, apps: [] });

test("group check input accepts 32 IDs and rejects 33 before deduplication", () => {
  const account = AccountId.make("acc_cap");
  assert.ok(Schema.is(AccountGroupCheck)({ accounts: Array.from({ length: 32 }, () => account) }));
  assert.equal(
    Schema.is(AccountGroupCheck)({ accounts: Array.from({ length: 33 }, () => account) }),
    false,
  );
  assert.equal(Schema.is(AccountGroupCheck)({ accounts: [] }), false);
});

test("group checks preserve per-account failures and finish usable siblings", async () => {
  for (const reason of ["registration", "binding", "changed", "unsupported"] as const) {
    const unavailable = new AccountAcquisitionUnavailable({ reason });
    const results = await Effect.runPromise(
      checkEach(ids, (account) =>
        Effect.gen(function* () {
          if (account === ids[1]) return yield* new AccountNotFound({ account });
          if (account === ids[2]) return yield* new StorageError();
          if (account === ids[3]) return yield* unavailable;
          return health(account);
        }),
      ),
    );
    assert.deepEqual(
      results.map(({ account, status }) => ({ account, status })),
      [
        { account: ids[0], status: "checked" },
        { account: ids[1], status: "refused" },
        { account: ids[2], status: "failed" },
        { account: ids[3], status: "failed" },
      ],
    );
    assert.deepEqual(results[1], { account: ids[1], status: "refused" });
    const failed = results[3];
    assert.equal(failed?.status, "failed");
    if (failed?.status !== "failed") throw new Error("Expected acquisition failure");
    assert.equal(failed.error, unavailable);
    assert.ok(Schema.is(AccountGroupCheckResult)(failed));
    const encoded = Schema.encodeSync(AccountGroupCheckResult)(failed);
    assert.ok(encoded.status === "failed");
    if (encoded.status === "failed") {
      assert.equal(encoded.error._tag, "AccountAcquisitionUnavailable");
      assert.ok("reason" in encoded.error);
      assert.equal(encoded.error.reason, reason);
    }
  }
});

test("group checks keep first-seen order, deduplicate IDs and run at most two at once", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls: AccountId[] = [];
      let active = 0;
      let maximum = 0;
      const pending = yield* checkEach([...ids, ids[0]!], (account) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            calls.push(account);
            active += 1;
            maximum = Math.max(maximum, active);
          }),
          () =>
            Effect.gen(function* () {
              if (calls.length === 2) yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return health(account);
            }),
          () =>
            Effect.sync(() => {
              active -= 1;
            }),
        ),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.equal(calls.length, 2);
      assert.equal(active, 2);
      yield* Deferred.succeed(release, undefined);
      const results = yield* Fiber.join(pending);
      assert.deepEqual(calls, ids);
      assert.deepEqual(
        results.map(({ account }) => account),
        ids,
      );
      assert.equal(maximum, 2);
      assert.equal(active, 0);
    }),
  );
});
