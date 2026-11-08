import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { callerHeader } from "../../apps/pool/contract.ts";
import { ImportSession } from "../../apps/pool/ui/import-session.ts";
import { handleSelfUsageImport } from "../../src/pool/model-history/self-import-http.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { historySchemaFixture, homeMetadataFixture } from "./history-fixture.ts";
import { managerBackup } from "./sqlite-upload-fixture.ts";
import { compiledSqliteSource } from "./sqlite-worker-source.ts";

const admin = process.env.POOL_TEST_ADMIN_URL;
const compiled = process.env.SQLITE_COMPILED_OUTPUT;
const available = admin && ["localhost", "127.0.0.1"].includes(new URL(admin).hostname);
test(
  "compiled SQLite worker previews without writes, applies explicitly, recovers lost replies and reimports idempotently",
  { skip: !available, timeout: 60000 },
  async () => {
    assert.ok(compiled, "Compile the actual worker before running this database proof");
    const dir = mkdtempSync(join(tmpdir(), "sqlite-import-")),
      path = join(dir, "usage.sqlite");
    const schema = `sqlite_import_${randomUUID().replaceAll("-", "")}`;
    const db = new pg.Client({ connectionString: admin });
    await db.connect();
    await historySchemaFixture(db, schema);
    await db.query(`SET search_path TO ${schema}`);
    await homeMetadataFixture(db);
    await migrateModelHistory(db);
    await db.end();
    const url = new URL(admin!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const query = async (sql: string) => {
      const client = new pg.Client({ connectionString: url.href });
      try {
        await client.connect();
        return await client.query(sql);
      } finally {
        await client.end();
      }
    };
    const count = async () =>
      Number((await query("SELECT count(*) AS n FROM basalt_model_requests")).rows[0].n);
    try {
      managerBackup(path);
      const signingKey = "ab".repeat(32);
      const token = await signPoolToken(signingKey, {
        pool: "fixture-sqlite",
        owner: "fixture-owner",
        organization: "fixture-organization",
      });
      const access = {
        signingKey,
        connectionString: url.href,
        permissions: async () => ({ canUse: true, canManage: true }),
      };
      let loseReply = false,
        pauseAfterApply = false;
      const calls: unknown[] = [];
      const session = new ImportSession(async (page) => {
        calls.push(page);
        const response = await handleSelfUsageImport(
          new Request("https://pool.example.test/pool/v1/usage/import/self", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              [callerHeader]: "fixture-manager",
              "content-type": "application/json",
            },
            body: JSON.stringify(page),
          }),
          access,
        );
        assert.equal(response.status, 200, await response.clone().text());
        if (page.mode === "apply" && loseReply) {
          loseReply = false;
          throw new Error("lost reply");
        }
        if (page.mode === "apply" && pauseAfterApply) {
          pauseAfterApply = false;
          session.pause();
        }
        return { ok: true, value: await response.json() };
      });
      const source = compiledSqliteSource(path, compiled!);
      await session.preview(source);
      assert.equal(session.snapshot.phase, "review", session.snapshot.error ?? "");
      assert.equal(session.snapshot.total, 401);
      assert.equal(await count(), 0, "preview must not write history");
      assert.doesNotMatch(JSON.stringify(calls), /private-|raw_json|auth_index|api_key_hash/);
      loseReply = true;
      await session.apply();
      assert.equal(session.snapshot.phase, "error");
      assert.equal(await count(), 200);
      pauseAfterApply = true;
      await session.apply();
      assert.equal(session.snapshot.phase, "paused");
      assert.equal(await count(), 200);
      await session.apply();
      assert.equal(session.snapshot.phase, "complete", session.snapshot.error ?? "");
      assert.equal(await count(), 401);
      assert.equal(
        Number(
          (
            await query(
              "SELECT count(*) AS n FROM basalt_model_requests WHERE person IS NOT NULL OR cost IS NOT NULL OR cost_basis <> 'unpriced'",
            )
          ).rows[0].n,
        ),
        0,
      );
      await session.preview(source);
      assert.equal(await count(), 401);
      await session.apply();
      assert.equal(session.snapshot.phase, "complete", session.snapshot.error ?? "");
      assert.equal(await count(), 401);
      assert.equal(session.snapshot.added, 0);
      assert.equal(session.snapshot.existing, 401);
    } finally {
      await query(`DROP SCHEMA ${schema} CASCADE`);
      rmSync(dir, { recursive: true });
    }
  },
);
