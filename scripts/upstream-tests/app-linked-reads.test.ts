import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { fixture, links } from "./app-linked-reads-fixture.ts";
import { oldListAppAccountLinks } from "./app-linked-reads-oracle.ts";
for (const snapshot of [false, true])
  for (const manager of [false, true])
    for (const editor of [false, true])
      for (const scope of ["app", "user"] as const)
        test(`link rows are byte-identical snapshot=${snapshot} manager=${manager} editor=${editor} scope=${scope}`, async () => {
          await Effect.runPromise(
            fixture(
              ({ app, reset }) =>
                Effect.gen(function* () {
                  const before = yield* oldListAppAccountLinks(app.id, scope);
                  reset();
                  const after = yield* links.listAppAccountLinks(app.id, scope);
                  assert.deepEqual(after, before);
                  assert.equal(JSON.stringify(after), JSON.stringify(before));
                  assert.equal(after.length, 4);
                  assert.equal(
                    after.some(
                      (row) => row.account.id === "acc_missing" || row.account.id === "acc_foreign",
                    ),
                    false,
                  );
                  const ordinary = after.find((row) => row.account.id === "acc_0")!;
                  const held = after.find((row) => row.account.id === "acc_1")!;
                  const acquired = after.find((row) => row.account.id === "acc_2")!;
                  assert.equal(ordinary.hostManaged, true);
                  assert.equal(acquired.credentialScope, "app");
                  assert.equal(acquired.signIn.state, "reconnect");
                  assert.equal(acquired.canReconnect, false);
                  assert.equal(held.canReconnect, true);
                  assert.equal(ordinary.health?.info === null, !(manager || editor));
                  assert.ok(held.health?.info);
                  assert.equal(held.canRemove, true);
                  if (scope === "app" && !manager && !editor) {
                    const ordinaryHeld = after.find(
                      (row) => row.account.id === "acc_1" && row.requirement === "plain",
                    )!;
                    assert.equal(ordinaryHeld.health?.info, null);
                    assert.equal(ordinaryHeld.canReconnect, false);
                  }
                }),
              { snapshot, manager, editor },
            ),
          );
        });
for (const snapshot of [false, true])
  for (const scope of ["app", "user"] as const)
    for (const count of [48, 96])
      test(`linked read budget snapshot=${snapshot} scope=${scope} saved=${count}`, async () => {
        await Effect.runPromise(
          fixture(
            ({ app, reads }) =>
              Effect.gen(function* () {
                yield* links.listAppAccountLinks(app.id, scope);
                assert.equal(reads.accountRows, 3, JSON.stringify(reads));
                assert.equal(reads.accountList, 1);
                assert.equal(reads.accountGet ?? 0, 0);
                assert.equal(
                  reads.healthRows ?? 0,
                  snapshot ? 0 : 3,
                  snapshot
                    ? "snapshot reads no health"
                    : "linked accounts read exactly three health rows",
                );
              }),
            { snapshot, count },
          ),
        );
      });
for (const snapshot of [false, true])
  test(`zero links skip account reads snapshot=${snapshot}`, async () => {
    await Effect.runPromise(
      fixture(
        ({ app, reads }) =>
          Effect.gen(function* () {
            assert.deepEqual(yield* links.listAppAccountLinks(app.id, "app"), []);
            assert.equal(reads.accountList ?? 0, 0);
            assert.equal(reads.accountGet ?? 0, 0);
          }),
        { snapshot, empty: true },
      ),
    );
  });

for (const snapshot of [false, true])
  for (const scope of ["app", "user"] as const)
    test(`provided accounts preserve the native rows snapshot=${snapshot} scope=${scope}`, async () => {
      await Effect.runPromise(
        fixture(
          ({ app, saved, reads, reset }) =>
            Effect.gen(function* () {
              const before = yield* oldListAppAccountLinks(app.id, scope, saved);
              reset();
              const after = yield* links.listAppAccountLinks(app.id, scope, saved);
              assert.equal(JSON.stringify(after), JSON.stringify(before));
              assert.equal(reads.accountList ?? 0, 0);
              assert.equal(reads.accountGet ?? 0, 0);
            }),
          { snapshot },
        ),
      );
    });
test("an account removed after listing stays omitted", async () => {
  await Effect.runPromise(
    fixture(
      ({ app }) =>
        Effect.gen(function* () {
          const before = yield* oldListAppAccountLinks(app.id, "app");
          const after = yield* links.listAppAccountLinks(app.id, "app");
          assert.deepEqual(after, before);
          assert.equal(
            after.some((row) => row.account.id === "acc_2"),
            false,
          );
        }),
      { deletedDuringRead: true },
    ),
  );
});
test("storage failures retain their error mapping", async () => {
  await Effect.runPromise(
    fixture(
      ({ app }) =>
        Effect.gen(function* () {
          const before = yield* Effect.result(oldListAppAccountLinks(app.id, "app"));
          const after = yield* Effect.result(links.listAppAccountLinks(app.id, "app"));
          assert.deepEqual(after, before);
          assert.equal(after._tag, "Failure");
          if (after._tag === "Failure") assert.equal(after.failure._tag, "StorageError");
        }),
      { storageFailure: true },
    ),
  );
});

for (const snapshot of [false, true])
  for (const scope of ["app", "user"] as const)
    test(`app access still denies before account reads snapshot=${snapshot} scope=${scope}`, async () => {
      await Effect.runPromise(
        fixture(
          ({ app, reads }) =>
            Effect.gen(function* () {
              const before = yield* Effect.result(oldListAppAccountLinks(app.id, scope));
              const after = yield* Effect.result(links.listAppAccountLinks(app.id, scope));
              assert.deepEqual(after, before);
              assert.equal(after._tag, "Failure");
              if (after._tag === "Failure")
                assert.equal(after.failure._tag, "OrganizationForbidden");
              assert.equal(reads.accountList ?? 0, 0);
              assert.equal(reads.accountGet ?? 0, 0);
            }),
          { snapshot, inaccessible: true },
        ),
      );
    });
