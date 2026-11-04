import assert from "node:assert/strict";
import { test } from "node:test";
import { Client, Pool } from "pg";
import { awaitManagementProvisioning } from "../../.upstream/apps/hosted/testing/management-provisioning.ts";

const deferred = <A>() => Promise.withResolvers<A>();

for (const held of ["listen", "readiness", "unlisten"] as const)
  test(
    `setup abort releases its client while ${held} is held`,
    { timeout: 5_000 },
    async (context) => {
      const database = new Pool();
      const releases: (Error | boolean | undefined)[] = [];
      const client = Object.assign(new Client(), {
        release: (error?: Error | boolean) => {
          releases.push(error);
        },
      });
      const entered = deferred<void>();
      const queryHeld = deferred<{ rows: { ready: boolean }[] }>();
      context.mock.method(database, "connect", async () => client);
      context.mock.method(client, "query", async (text: string) => {
        const operation = text.startsWith("listen ")
          ? "listen"
          : text.startsWith("unlisten ")
            ? "unlisten"
            : "readiness";
        if (operation === held) {
          entered.resolve();
          return queryHeld.promise;
        }
        return { rows: [{ ready: true }] };
      });
      const signal = new AbortController();
      const pending = awaitManagementProvisioning(database, "organization", "user", signal.signal);
      const rejected = assert.rejects(pending, { _tag: "ManagementProvisioningFailed" });
      try {
        await entered.promise;
        signal.abort();
        await rejected;
        assert.deepEqual(releases, [true], "discard the client before the held query settles");
        assert.equal(client.listenerCount("notification"), 0);
        assert.equal(client.listenerCount("error"), 0);
      } finally {
        queryHeld.resolve({ rows: [{ ready: true }] });
        await Promise.allSettled([pending]);
        await database.end();
      }
    },
  );

test(
  "setup abort rejects a held checkout and disposes its late client",
  { timeout: 5_000 },
  async (context) => {
    const database = new Pool();
    const releases: (Error | boolean | undefined)[] = [];
    const client = Object.assign(new Client(), {
      release: (error?: Error | boolean) => {
        releases.push(error);
      },
    });
    const acquisition = deferred<typeof client>();
    const entered = deferred<void>();
    context.mock.method(database, "connect", () => {
      entered.resolve();
      return acquisition.promise;
    });
    const query = context.mock.method(client, "query");
    const signal = new AbortController();
    const pending = awaitManagementProvisioning(database, "organization", "user", signal.signal);
    const rejected = assert.rejects(pending, { _tag: "ManagementProvisioningFailed" });
    try {
      await entered.promise;
      signal.abort();
      await rejected;
      assert.deepEqual(releases, []);
      acquisition.resolve(client);
      // The helper's already-registered checkout callback runs before this continuation.
      await acquisition.promise;
      assert.deepEqual(releases, [true]);
      assert.equal(query.mock.callCount(), 0);
    } finally {
      acquisition.resolve(client);
      await Promise.allSettled([pending]);
      await database.end();
    }
  },
);

test("an already-aborted setup never acquires a client", async (context) => {
  const database = new Pool();
  const connect = context.mock.method(database, "connect");
  const signal = new AbortController();
  signal.abort();
  try {
    await assert.rejects(
      awaitManagementProvisioning(database, "organization", "user", signal.signal),
      { _tag: "ManagementProvisioningFailed" },
    );
    assert.equal(connect.mock.callCount(), 0);
  } finally {
    await database.end();
  }
});
