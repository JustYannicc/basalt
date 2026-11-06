import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Fiber } from "effect";
import { waitForHeldCall } from "./recipes/held-call.mjs";
import { root, runtime, until } from "./recipes/harness.mjs";
import { poolCloudHarness } from "./recipes/pool-cloud-harness.mjs";
import { nativePoolAccount } from "./recipes/native-pool-account.mjs";
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(`${root}/.upstream`);
const checks = [];
const checked = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const h = yield* poolCloudHarness(directory, { resets: true });
      const identity = yield* h.request("GET", "/api/auth/get-session");
      const apps = yield* until(
        h.request("GET", `${h.prefix}/apps`),
        (apps) => apps.some((app) => app.name === `${identity.user.name}'s pool`),
        "pool was not provisioned",
      );
      const pool = apps.find((app) => app.name === `${identity.user.name}'s pool`);
      yield* until(
        h.request("GET", `${h.appPath(pool.id)}/accounts/app`),
        (links) => links.some((link) => link.requirement === "pool" && link.hostManaged),
        "pool access was not linked",
      );
      const saved = yield* nativePoolAccount(h, pool, "synthetic-intent-a");
      checked(
        "member cannot unlink the owner's saved pool account",
        (yield* h.raw("member", "DELETE", saved.unlink)).status,
        403,
      );
      checked(
        "member cannot delete the owner's saved credential",
        (yield* h.raw("member", "DELETE", saved.remove)).status,
        403,
      );
      checked(
        "denied member removal records no intent",
        (yield* h.call(pool.id, "view", { fresh: true })).value.removals.items.length,
        0,
      );
      yield* h.request("DELETE", saved.unlink);
      yield* Effect.promise(() => h.fixture.reconcile(pool.id));
      const view = yield* h.call(pool.id, "view", { fresh: true });
      checked(
        "public native unlink records an intentional pool removal",
        view.value.removals.items.length,
        1,
      );
      checked(
        "the receipt uses the authenticated person",
        view.value.removals.items[0].actor,
        identity.user.id,
      );
      checked(
        "the receipt names the removed Home reference",
        view.value.removals.items[0].account,
        saved.reference,
      );
      yield* h.request("DELETE", saved.remove);
      const gone = yield* h.raw("owner", "GET", saved.remove);
      checked("deleted saved credentials retain the privacy response", gone.status, 403);
      checked(
        "deleted saved credentials expose no metadata",
        gone.body._tag,
        "OrganizationForbidden",
      );
      checked(
        "saved credential deletion succeeds after unlink",
        h.fixture.hasCredential(saved.reference),
        false,
      );
      const deleted = yield* nativePoolAccount(h, pool, "synthetic-intent-b");
      yield* h.request("DELETE", deleted.remove);
      const afterDelete = (yield* h.call(pool.id, "view", {
        fresh: true,
      })).value.removals.items.find((item) => item.account === deleted.reference);
      checked(
        "public saved-account deletion records its current acting person",
        afterDelete?.actor,
        identity.user.id,
      );
      const concurrent = yield* nativePoolAccount(h, pool, "synthetic-intent-c");
      const held = h.fixture.holdUnlink(concurrent.reference);
      const unlinking = yield* h.request("DELETE", concurrent.unlink).pipe(Effect.forkChild);
      let observedAt;
      try {
        yield* waitForHeldCall(unlinking, held.started, "native saved-account unlink");
        h.fixture.seed(pool.id, concurrent.reference, { attemptedAt: Date.now() });
        const during = yield* h.call(pool.id, "view", { fresh: true });
        observedAt = Date.parse(
          during.value.accounts.find((account) => account.id === concurrent.reference).observedAt,
        );
        checked("the account remains observable while Home unlink is held", observedAt > 0, true);
      } finally {
        held.release();
      }
      yield* Fiber.join(unlinking);
      const afterUnlink = (yield* h.call(pool.id, "view", {
        fresh: true,
      })).value.removals.items.find((item) => item.account === concurrent.reference);
      checked(
        "native unlink acknowledgement follows the concurrent observation",
        Date.parse(afterUnlink?.at) >= observedAt,
        true,
      );
      checked(
        "native unlink keeps the saved account reusable",
        (yield* h.raw("owner", "GET", concurrent.remove)).status,
        200,
      );
      yield* h.request("DELETE", concurrent.remove);
    }).pipe(Effect.scoped, Effect.provide(runtime)),
  );
  await writeFile(`${directory}/report.json`, JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ checks: checks.length }));
} catch (error) {
  await writeFile(`${directory}/partial-checks.json`, JSON.stringify(checks));
  await writeFile(`${directory}/failure.txt`, String(error?.stack ?? error));
  console.error("Native removal intent proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
