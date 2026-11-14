import assert from "node:assert/strict";
import test from "node:test";
import { readMigrationAppVersions } from "./migration-activation-readers.ts";

function fixture(rows: Record<string, unknown>[]) {
  const cursors: unknown[] = [];
  const transactions: string[] = [];
  let closed = false;
  let complete = true;
  return {
    cursors,
    transactions,
    closed: () => closed,
    incomplete: () => {
      complete = false;
    },
    source: {
      databaseName: "tools-fixture",
      connect: async () => ({
        query: async (text: string, values?: unknown[]) => {
          if (text.includes("database_matches"))
            return { rows: [{ database_matches: true, schema_matches: true, read_only: true }] };
          if (text.includes("AS complete")) return { rows: [{ complete }] };
          if (text.includes("a.active_deployment AS active")) {
            const after = values?.[0];
            assert.equal(typeof after, "string");
            cursors.push(after);
            return {
              rows: rows.filter((row) => String(row.id) > String(after)).slice(0, 201),
            };
          }
          transactions.push(text);
          return { rows: [] };
        },
        end: async () => {
          closed = true;
        },
      }),
    },
  };
}

const app = (index: number) => ({
  id: `app_${String(index).padStart(4, "0")}`,
  code: `code_${index}`,
  owner: "organization:synthetic",
  active: `dpl_${index}`,
  build: `bld_${index}`,
  commit: null,
  pools: [],
});

test("installed version inventory keeps the page sentinel and binds version associations", async () => {
  const rows = Array.from({ length: 202 }, (_, index) => app(index));
  const first = fixture(rows);
  const initial = await readMigrationAppVersions(first.source);
  assert.equal(initial.count, 202);
  assert.deepEqual(first.cursors, ["", "app_0199"]);
  assert.equal(first.transactions.at(-1), "COMMIT");
  assert.equal(first.closed(), true);
  assert.deepEqual(await readMigrationAppVersions(fixture(rows).source), initial);
  const changed = rows.map((row, index) =>
    index === 201 ? { ...row, build: "bld_changed" } : row,
  );
  assert.notEqual(
    (await readMigrationAppVersions(fixture(changed).source)).fingerprint,
    initial.fingerprint,
  );
});

test("a dangling active version refuses the whole inventory and closes its snapshot", async () => {
  const current = fixture([{ ...app(1), build: null }]);
  await assert.rejects(readMigrationAppVersions(current.source), {
    reason: "migration-reader-apps-version-association",
  });
  assert.equal(current.transactions.at(-1), "ROLLBACK");
  assert.equal(current.closed(), true);
});

test("pool references outside the installed app owner refuse instead of disappearing from the digest", async () => {
  const current = fixture([app(1)]);
  current.incomplete();
  await assert.rejects(readMigrationAppVersions(current.source), {
    reason: "migration-reader-apps-pool-association",
  });
  assert.deepEqual(current.cursors, []);
  assert.equal(current.transactions.at(-1), "ROLLBACK");
  assert.equal(current.closed(), true);
});
