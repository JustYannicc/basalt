import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { decryptArtifact } from "../production-ops/artifact.ts";
import { productionOperation } from "../production-ops/client.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { importRecoveryName, importRemovalName } from "../../src/pool/import-removal/paths.ts";
import { removalSelection } from "../../src/pool/import-removal/contract.ts";
import { handleImportRemoval } from "../../src/pool/import-removal/http.ts";
import { ImportRemoval } from "../../src/pool/import-removal/operation.ts";
import { removalSnapshot } from "../../src/pool/import-removal/snapshot.ts";
import { withHistoryDatabase } from "../../src/pool/model-history/database.ts";
import { handleRequest } from "../../src/router.ts";
import { MemoryStorage, SharingFixture, type HomeProvider } from "./sharing-fixture.ts";

test("signed import removal backs up four exact Home rows, refuses drift and uncertain retries, preserves the retained account and serves it", { timeout: 480_000 }, async () => {
  const fixture = new SharingFixture({ resourcePrefix: "basalt-import-removal", exposeDatabase: true,
    onStage: stage => console.log(stage) });
  let sql: pg.Client | undefined;
  try {
    await fixture.start();
    const client = new HomeClient((path, init) => fixture.fetchHome(path, init));
    const providers = await fixture.data<HomeProvider[]>("/config/api-keys/openai-compatibility");
    const retained = providers.find(row => row.name === "fixture-p1")?.keys[0];
    assert.ok(retained);
    const imports = [];
    for (const [index, provider] of ["claude", "claude", "codex", "xai"].entries()) {
      const saved = await fixture.data<{ name: string }>("/credentials", "POST", {
        type: provider, email: `fixture-${index}@example.invalid`, disabled: true,
        access_token: `synthetic-${provider}-${index}-token`, refresh_token: `synthetic-${provider}-${index}-refresh`,
        expired: "2099-01-01T00:00:00Z", expiry: "2099-01-01T00:00:00Z", proxy_url: "http://127.0.0.1:1",
      });
      imports.push({ id: saved.name.replace(/\.json$/, ""), provider });
    }
    const pool = `removal-${randomUUID()}`;
    await new PoolHome(client, pool).add([...imports.map(row => row.id), retained.id]);
    sql = new pg.Client({ connectionString: fixture.database });
    await sql.connect();
    const retainRow = (await sql.query("SELECT provider FROM auth WHERE uuid=$1", [retained.id])).rows[0];
    const selection = removalSelection({ organization: "fixture-organization", pool, remove: imports,
      retain: { id: retained.id, provider: retainRow.provider } });
    // This value cannot round-trip through a JavaScript number in a full-row backup.
    await sql.query("UPDATE auth SET version=9007199254740993 WHERE uuid=$1", [imports[0]!.id]);
    const key = await new ComputerHome(client).mint("fixture-removal-owner", pool, "fixture-removal-client");
    const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const recipient = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const target = "https://pool.example.test";
    const secret = "ab".repeat(32);
    const read = () => withHistoryDatabase(fixture.database, db => removalSnapshot(db, selection));
    const storage = new MemoryStorage();
    const deps = { read, ready: async () => {}, home: (path: string, init: RequestInit) => client.response(path, init), storage,
      secret, release: "fixture-release", databaseOrigin: "fixture-database" };
    let operation = new ImportRemoval(deps);
    const defaults = { target, signingKey: secret, selection: importRemovalName, mode: "dry-run", request: JSON.stringify(selection),
      recipient, planSha256: "", go: "", action: "migrate" };
    const invoke = (input: Partial<typeof defaults> & { previous?: unknown } = {}) => productionOperation({ ...defaults, ...input },
      async (url, init) => handleRequest(new Request(String(url), init), {
        DASHBOARD_HOST: new URL(target).hostname,
        POOL_SERVICE: { fetch: request => handleImportRemoval(request, operation, secret, target) },
        TOOLS_SERVICE: { fetch: async () => { throw new Error("Pool operations reached the Executor database service"); } },
        CATALOG_SERVICE: { fetch: async () => { throw new Error("Pool operations reached the catalog service"); } },
        POOL_APP_SIGNING_KEY: secret,
      }));
    const decrypt = (value: unknown) => JSON.parse(decryptArtifact(value, privateKey, target));
    const before = await read();
    const deletes = () => fixture.events.filter(event => event.method === "DELETE").length;
    const initialDeletes = deletes();
    const weakRecipient = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    await assert.rejects(invoke({ action: "backup", recipient: weakRecipient }), "Recovery recipients must retain the existing RSA 3072 minimum");
    const standalone = await invoke({ action: "backup" });
    const standaloneBackup = decrypt(standalone.artifact);
    assert.equal(standaloneBackup.credentials.length, 4);
    assert.deepEqual(standaloneBackup.credentials.map((row: { id: string }) => row.id), selection.remove.map(row => row.id));
    assert.ok(!JSON.stringify(standaloneBackup.credentials).includes(retained.id), "The retained credential row must never enter the backup");
    assert.ok(standaloneBackup.credentials.some((row: { row: string }) => row.row.includes("9007199254740993")));
    assert.equal(deletes(), initialDeletes);

    await sql.query("UPDATE channel_group_detail SET deleted_at=now() WHERE auth_id=$1", [retained.id]);
    await assert.rejects(invoke(), "The retained credential must still belong to the pool");
    await sql.query("UPDATE channel_group_detail SET deleted_at=NULL WHERE auth_id=$1", [retained.id]);

    let dry = await invoke();
    const backup = decrypt(dry.backup);
    const plan = decrypt(dry.artifact);
    assert.equal(plan.projection.credentials.length, 4);
    assert.equal(plan.projection.memberships.length, 4);
    assert.equal(plan.projection.retain.id, retained.id);
    assert.ok(!JSON.stringify(dry).includes("synthetic-"), "Only encrypted credential material can leave the handler");
    assert.equal(deletes(), initialDeletes);
    const approve = (previous: typeof dry) => {
      const artifact = previous.artifact;
      assert.ok(artifact && typeof artifact === "object" && "sha256" in artifact && typeof artifact.sha256 === "string");
      return { mode: "apply", previous, planSha256: artifact.sha256, go: `GO ${artifact.sha256}` };
    };
    await assert.rejects(invoke({ ...approve(dry), go: "" }));
    await assert.rejects(invoke({ ...approve(dry), signingKey: "cd".repeat(32) }));
    await assert.rejects(invoke({ ...approve(dry), request: JSON.stringify({ ...selection, pool: "other-pool" }) }));
    await assert.rejects(invoke({ request: JSON.stringify({ ...selection, remove: selection.remove.slice(0, 3) }) }));
    await assert.rejects(invoke({ request: JSON.stringify({ ...selection, retain: selection.remove[0] }) }));
    operation = new ImportRemoval({ ...deps, release: "different-release" });
    await assert.rejects(invoke(approve(dry)));
    operation = new ImportRemoval({ ...deps, databaseOrigin: "different-database" });
    await assert.rejects(invoke(approve(dry)));
    operation = new ImportRemoval({ ...deps, now: () => Date.now() + 3_600_001 });
    await assert.rejects(invoke(approve(dry)));
    operation = new ImportRemoval(deps);
    assert.equal(deletes(), initialDeletes);

    await fixture.data("/credentials/status", "PATCH", { name: imports[1]!.id, disabled: false });
    await assert.rejects(invoke(approve(dry)), "A changed credential invalidates its backed-up dry run");
    await fixture.data("/credentials/status", "PATCH", { name: imports[1]!.id, disabled: true });
    assert.equal(deletes(), initialDeletes);
    dry = await invoke();
    const failedStorage = new MemoryStorage();
    operation = new ImportRemoval({ ...deps, storage: failedStorage, home: async () => new Response(null, { status: 503 }) });
    await assert.rejects(invoke(approve(dry)));
    operation = new ImportRemoval({ ...deps, storage: failedStorage });
    await assert.rejects(invoke(approve(dry)), "A restarted operator must not replay an uncertain DELETE");
    const failed = await invoke({ action: "inventory", planSha256: approve(dry).planSha256 });
    assert.equal(decrypt(failed.artifact).receipt.status, "incomplete");
    assert.equal(deletes(), initialDeletes);

    const originalReceipt = decrypt(failed.artifact).receipt;
    const prepare = () => invoke({ action: "prepare", selection: importRecoveryName, previous: dry, planSha256: approve(dry).planSha256 });
    let recovery = await prepare();
    operation = new ImportRemoval({ ...deps, storage: failedStorage, home: async (path, init) => {
      const response = await client.response(path, init);
      assert.ok(response.ok);
      await response.body?.cancel();
      throw new Error("Synthetic lost DELETE acknowledgement");
    } });
    await assert.rejects(invoke({ ...approve(recovery), selection: importRecoveryName }));
    assert.equal(deletes() - initialDeletes, 1);
    const interrupted = await read();
    assert.equal(interrupted.credentials.filter(row => row.deleted).length, 1);
    operation = new ImportRemoval({ ...deps, storage: failedStorage });
    await assert.rejects(invoke({ ...approve(recovery), selection: importRecoveryName }), "An uncertain recovery also needs a new reviewed plan");
    recovery = await prepare();
    assert.equal(recovery.changes, 7);
    const result = await invoke({ ...approve(recovery), selection: importRecoveryName });
    assert.equal(result.action, "resume");
    assert.deepEqual(result.verification, { ok: true, checks: { credentialsRemoved: true, membershipsRemoved: true, retainedUnchanged: true } });
    const originalAfter = await invoke({ action: "inventory", planSha256: approve(dry).planSha256 });
    assert.deepEqual(decrypt(originalAfter.artifact).receipt, originalReceipt, "Recovery preserves the original incomplete receipt");
    const after = await read();
    assert.ok(after.credentials.every(row => row.deleted));
    assert.ok(after.memberships.every(row => row.deleted));
    assert.deepEqual(after.retain, before.retain);
    const expectedPaths = [...selection.remove.map(row => `/v8/management/credentials?id=${row.id}`),
      ...before.memberships.map(row => `/v8/management/channel-group-details/${row.id}`)].sort();
    assert.deepEqual(fixture.events.filter(event => event.method === "DELETE").map(event => event.path).sort(), expectedPaths);
    const repeated = await invoke({ ...approve(recovery), selection: importRecoveryName });
    assert.equal(repeated.repeated, true);
    assert.equal(deletes() - initialDeletes, 8);
    assert.deepEqual((await new PoolHome(client, pool).membership()).members.map(row => row.auth_id), [retained.id]);
    assert.deepEqual((await fixture.data<{ files: { id: string }[] }>("/credentials")).files.filter(row => selection.remove.some(item => item.id === row.id)), []);

    // Recover into isolated temporary tables to prove exact row data survives encryption and bigint decoding.
    await sql.query("CREATE TEMP TABLE removal_restore (LIKE auth INCLUDING ALL)");
    for (const row of backup.credentials) await sql.query("INSERT INTO removal_restore SELECT * FROM json_populate_record(NULL::auth, $1::json)", [row.row]);
    const restored = (await sql.query("SELECT to_jsonb(a)::text AS row FROM removal_restore a ORDER BY uuid")).rows.map(row => row.row);
    assert.deepEqual(restored, backup.credentials.map((row: { row: string }) => row.row));
    await sql.query("CREATE TEMP TABLE membership_restore (LIKE channel_group_detail INCLUDING ALL)");
    for (const row of backup.memberships) await sql.query("INSERT INTO membership_restore SELECT * FROM json_populate_record(NULL::channel_group_detail, $1::json)", [row.row]);
    assert.deepEqual((await sql.query("SELECT to_jsonb(m)::text AS row FROM membership_restore m ORDER BY id")).rows.map(row => row.row),
      backup.memberships.map((row: { row: string }) => row.row));
    const response = await fixture.model(key.key, "retained-after-removal");
    const stream = await response.text();
    assert.equal(response.status, 200, stream);
    assert.match(stream, /"content":"P1"/);
    assert.match(stream, /data: \[DONE\]/);
  } finally { await sql?.end(); await fixture.close(); }
});
