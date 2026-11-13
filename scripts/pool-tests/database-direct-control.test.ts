import assert from "node:assert/strict";
import { test } from "node:test";
import { budgetFixture } from "./database-budget/fixture.ts";
import { homeProcess } from "./database-budget/home-process.ts";
import { connect, runtimeUrl, waitForBackendCount } from "./database-budget/postgres.ts";

const binary = process.env.POOL_TEST_HOME_BUDGET_CLIENT;
test(
  "the previous direct transport exceeds the shared budget with eight Home processes",
  { skip: !binary, timeout: 30_000 },
  async (t) => {
    const fixture = await budgetFixture("negative");
    const children: Awaited<ReturnType<typeof homeProcess>>[] = [];
    const controlUrl = new URL(fixture.direct);
    controlUrl.pathname = "/" + fixture.database;
    const control = await connect(controlUrl);
    try {
      for (let index = 0; index < 8; index++)
        children.push(
          await homeProcess(
            binary!,
            runtimeUrl(fixture.direct, fixture.database, index % 2 ? "budget_b" : "budget_a"),
          ),
        );
      assert.equal((await children[0]!.request("migrate")).ok, true);
      assert.equal((await children[0]!.request("initialize")).ok, true);
      await control.query("BEGIN");
      await control.query("LOCK TABLE lifecycle_config IN ACCESS EXCLUSIVE MODE");
      const requests = children.map((child) => child.request("update"));
      try {
        const count = await waitForBackendCount(
          fixture.admin,
          [fixture.database],
          8,
          undefined,
          "at-least",
        );
        assert.ok(count > 5, "The unchanged direct transport must expose the missing global cap");
        await control.query("COMMIT");
        assert.ok((await Promise.all(requests)).every((result) => result.ok));
        t.diagnostic(JSON.stringify({ directProcesses: 8, backendPeak: count, rejectedBudget: 5 }));
      } finally {
        await control.query("ROLLBACK");
        await Promise.allSettled(requests);
      }
    } finally {
      await Promise.all(children.map((child) => child.close()));
      await control.end();
      await fixture.close();
    }
  },
);
