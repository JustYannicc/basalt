import assert from "node:assert/strict";
import { test } from "node:test";
import { unregisterPools, unregisteredPools } from "./rehearsal-fixture-sql.ts";

function client(type: string, removed: number, rowCount = 1) {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  return {
    statements,
    query: async <Row>(text: string, values?: unknown[]) => {
      statements.push({ text, values });
      const rows: unknown[] = text.includes("information_schema")
        ? [{ data_type: type }]
        : text.includes("update organization")
          ? [{ removed: String(removed) }]
          : [];
      return { rows: rows as Row[], rowCount: text.includes("update organization") ? rowCount : rows.length };
    },
  };
}

test("exactly the named registrations go in one transaction, cast for the column's type", async () => {
  for (const type of ["text", "jsonb"]) {
    const db = client(type, 2);
    assert.equal(await unregisterPools(db, "org", ["app_a", "app_b"]), 2);
    const update = db.statements.find((statement) => statement.text.includes("update organization"))!;
    assert.deepEqual(update.values, ["org", ["app_a", "app_b"]]);
    assert.equal(update.text.includes("k.pools)::text"), type === "text");
    assert.deepEqual(db.statements.map((statement) => statement.text.split(/\s/)[0]).filter((word) => word === "begin" || word === "commit"), ["begin", "commit"]);
  }
});

test("a missing registration, organization or unknown column rolls back and refuses", async () => {
  for (const db of [client("text", 1), client("text", 2, 0), client("json", 2)]) {
    await assert.rejects(unregisterPools(db, "org", ["app_a", "app_b"]));
    assert.equal(db.statements.at(-1)!.text, "rollback");
  }
});

test("pool inputs must be distinct app ids", () => {
  assert.deepEqual(unregisteredPools("app_a,app_b"), ["app_a", "app_b"]);
  for (const value of [undefined, "", "app_a,app_a", "pool-1", "app_a,"]) assert.throws(() => unregisteredPools(value));
});
