import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { readMigrationAppVersions } from "./migration-activation-readers.ts";
import { BarrierRefusal, canonical } from "./manifest.ts";
import { refusalTable } from "./refusal-report.ts";

function fixture(rows: Record<string, unknown>[], associations: Record<string, unknown>[] = []) {
  const cursors: unknown[] = [];
  const transactions: string[] = [];
  let closed = false;
  return {
    cursors,
    transactions,
    closed: () => closed,
    source: {
      databaseName: "tools-fixture",
      connect: async () => ({
        query: async (text: string, values?: unknown[]) => {
          if (text.includes("database_matches"))
            return { rows: [{ database_matches: true, schema_matches: true, read_only: true }] };
          if (text.includes("AS actual_owner")) return { rows: associations };
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
  const current = fixture(
    [app(1)],
    [
      {
        organization: "org_fixture",
        slot: "person_fixture",
        app: "app_0001",
        actual_owner: "organization:another",
        reason: "wrong-owner",
      },
    ],
  );
  await assert.rejects(readMigrationAppVersions(current.source), {
    reason: "migration-reader-apps-pool-association",
  });
  assert.deepEqual(current.cursors, []);
  assert.equal(current.transactions.at(-1), "ROLLBACK");
  assert.equal(current.closed(), true);
});

async function sqlFixture() {
  const database = new PGlite();
  await database.exec(`CREATE TABLE organization(id text PRIMARY KEY,metadata text);
    CREATE TABLE executor_apps(id text PRIMARY KEY,code text,owner text,active_deployment text);
    CREATE TABLE executor_deployments(id text PRIMARY KEY,code text,owner text,build text,source_commit text);
    INSERT INTO organization VALUES('org_fixture','{}');
    INSERT INTO executor_apps VALUES
      ('app_valid','private-app-code','organization:org_fixture',NULL),
      ('app_foreign','private-foreign-code','user:person_fixture',NULL);`);
  const sessions: { statements: string[]; closed: boolean }[] = [];
  return {
    database,
    sessions,
    pools: (pools: unknown, organization = "org_fixture") =>
      database.query(
        "INSERT INTO organization VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata",
        [organization, JSON.stringify({ basaltPools: pools, private: "private-metadata" })],
      ),
    source: {
      databaseName: "postgres",
      connect: async () => {
        const session = { statements: [] as string[], closed: false };
        sessions.push(session);
        return {
          query: async (text: string, values?: unknown[]) => {
            session.statements.push(text);
            return database.query<Record<string, unknown>>(text, values);
          },
          end: async () => {
            session.closed = true;
          },
        };
      },
    },
  };
}

function expectedAssociation(
  index: number,
  slot: string | null,
  app: string | null,
  owner: string | null,
  reason: string,
  organization = "org_fixture",
) {
  const context = { organization, slot, app };
  return {
    path: `poolAssociations[${index}]`,
    old: canonical({
      ...context,
      owner: organization === "invalid-id" ? "invalid-owner" : `organization:${organization}`,
    }),
    new: canonical({ ...context, owner, reason }),
  };
}

function assertSnapshotClosed(f: Awaited<ReturnType<typeof sqlFixture>>, outcome: string) {
  const session = f.sessions.at(-1)!;
  assert.equal(
    session.statements[0],
    "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  assert.equal(session.statements.at(-1), outcome);
  assert.equal(session.closed, true);
  assert.ok(
    session.statements.every((text) => !/^(CREATE|INSERT|UPDATE|DELETE|ALTER|DROP)/.test(text)),
  );
}

test("real SQL keeps valid same-owner pool associations in the unchanged app fingerprint", async () => {
  const f = await sqlFixture();
  try {
    await f.pools({ person_fixture: { app: "app_valid", version: "version_fixture" } });
    const result = await readMigrationAppVersions(f.source);
    const hash = createHash("sha256");
    for (const row of [
      {
        id: "app_foreign",
        code: "private-foreign-code",
        owner: "user:person_fixture",
        active: null,
        build: null,
        commit: null,
        pools: [],
      },
      {
        id: "app_valid",
        code: "private-app-code",
        owner: "organization:org_fixture",
        active: null,
        build: null,
        commit: null,
        pools: [
          {
            organization: "org_fixture",
            slot: "person_fixture",
            version: "version_fixture",
            authorization: null,
            membership: null,
          },
        ],
      },
    ])
      hash.update(canonical(row)).update("\n");
    assert.deepEqual(result, { count: 2, fingerprint: hash.digest("hex") });
    assertSnapshotClosed(f, "COMMIT");
  } finally {
    await f.database.close();
  }
});

test("real SQL names every missing reference, missing app and wrong owner before rolling back", async () => {
  const f = await sqlFixture();
  try {
    await f.pools({
      good: { app: "app_valid" },
      missing_app: { app: "app_missing" },
      missing_reference: { version: "private-version" },
      wrong_owner: { app: "app_foreign" },
    });
    await assert.rejects(readMigrationAppVersions(f.source), (error: unknown) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.equal(error.reason, "migration-reader-apps-pool-association");
      assert.equal(error.worker, "SQL.tools");
      assert.deepEqual(error.delta, {
        fqn: "SQL.tools",
        type: "PoolAssociation",
        changed: [
          expectedAssociation(0, "missing_app", "app_missing", null, "app-missing"),
          expectedAssociation(1, "missing_reference", null, null, "missing-app-reference"),
          expectedAssociation(
            2,
            "wrong_owner",
            "app_foreign",
            "user:person_fixture",
            "wrong-owner",
          ),
        ],
      });
      const publicFailure = JSON.stringify(error) + refusalTable(error);
      assert.match(publicFailure, /org_fixture.*missing_app.*app_missing/);
      assert.match(publicFailure, /organization:org_fixture/);
      assert.match(publicFailure, /user:person_fixture/);
      assert.doesNotMatch(publicFailure, /private-|version_fixture/);
      return true;
    });
    assertSnapshotClosed(f, "ROLLBACK");
    assert.ok(
      !f.sessions.at(-1)!.statements.some((text) => text.includes("a.active_deployment AS active")),
    );
  } finally {
    await f.database.close();
  }
});

test("real SQL refuses a 51st mismatch as overflow and never emits the sentinel row", async () => {
  const f = await sqlFixture();
  try {
    for (const count of [50, 51]) {
      await f.pools(
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `slot_${String(index).padStart(3, "0")}`,
            { app: `app_missing_${index}` },
          ]),
        ),
      );
      await assert.rejects(readMigrationAppVersions(f.source), (error: unknown) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.equal(error.reason, "migration-reader-apps-pool-association");
        const expected = Array.from({ length: 50 }, (_, index) =>
          expectedAssociation(
            index,
            `slot_${String(index).padStart(3, "0")}`,
            `app_missing_${index}`,
            null,
            "app-missing",
          ),
        );
        if (count === 51)
          expected.push({ path: "poolAssociations.inventory", old: "complete", new: "overflow" });
        assert.deepEqual(error.delta?.changed, expected);
        assert.doesNotMatch(JSON.stringify(error) + refusalTable(error), /app_missing_50|slot_050/);
        return true;
      });
      assertSnapshotClosed(f, "ROLLBACK");
    }
  } finally {
    await f.database.close();
  }
});

test("real SQL retains safe context while redacting malformed IDs and owners", async () => {
  const f = await sqlFixture();
  try {
    await f.database.query("INSERT INTO executor_apps VALUES($1,$2,$3,NULL)", [
      "app_private_owner",
      "private-app-source",
      "user:private-person@example.invalid",
    ]);
    await f.pools({
      app_object: { app: { secret: "private-object-value" } },
      app_number: { app: 23 },
      app_null: { app: null },
      app_string: { app: "private-app@example.invalid" },
      app_owner: { app: "app_private_owner" },
      ["private-slot@example.invalid"]: { app: "app_missing" },
      ["x".repeat(257)]: { app: `app_${"y".repeat(252)}` },
      ["slot\nprivate-line"]: { app: "app_missing\n" },
      ghp_private_credential: { app: "app_missing" },
    });
    await f.pools({ safe_slot: { app: "app_missing" } }, "private-org@example.invalid");
    await assert.rejects(readMigrationAppVersions(f.source), (error: unknown) => {
      assert.ok(error instanceof BarrierRefusal);
      const changes = error.delta!.changed;
      assert.equal(changes.length, 10);
      assert.ok(
        changes.some(
          (change) =>
            "new" in change &&
            change.new ===
              canonical({
                organization: "org_fixture",
                slot: "app_object",
                app: "invalid-id",
                owner: null,
                reason: "invalid-app-reference",
              }),
        ),
      );
      assert.ok(
        changes.some(
          (change) =>
            "new" in change &&
            change.new ===
              canonical({
                organization: "org_fixture",
                slot: "app_owner",
                app: "app_private_owner",
                owner: "invalid-owner",
                reason: "wrong-owner",
              }),
        ),
      );
      assert.ok(
        changes.some(
          (change) =>
            "old" in change &&
            change.old ===
              canonical({
                organization: "invalid-id",
                slot: "safe_slot",
                app: "app_missing",
                owner: "invalid-owner",
              }),
        ),
      );
      const publicFailure = JSON.stringify(error) + refusalTable(error);
      assert.doesNotMatch(
        publicFailure,
        /example\.invalid|private-object|private-app-source|private-metadata|ghp_private|private-line|x{257}|y{252}/,
      );
      return true;
    });
    assertSnapshotClosed(f, "ROLLBACK");
    await f.database.query("DELETE FROM organization WHERE id <> 'org_fixture'");
    await f.pools(["private-map-value"]);
    await assert.rejects(readMigrationAppVersions(f.source), (error: unknown) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.deepEqual(error.delta?.changed, [
        expectedAssociation(0, null, null, null, "invalid-pool-map"),
      ]);
      return true;
    });
    assertSnapshotClosed(f, "ROLLBACK");
  } finally {
    await f.database.close();
  }
});
