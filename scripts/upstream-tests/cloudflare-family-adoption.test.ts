import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
  apply,
  catalogProvider,
  catalogSource,
  changed,
  dryRun,
  everything,
  identify,
  identifyStored,
  link,
  listed,
  providers,
  reasonOf,
  run,
  teamA,
  world,
} from "./cloudflare-family-fixture.ts";

const ids = (rows: readonly Record<string, unknown>[], key = "id") =>
  rows.map((row) => row[key]).sort();
/** The fields that differ between a row's before and after values. */
const fieldsChanged = (
  entry: { gone: Record<string, unknown>[]; added: Record<string, unknown>[] },
  key = "id",
) =>
  entry.gone.map((before) => {
    const after = entry.added.find((row) => row[key] === before[key]);
    assert.ok(after, `row ${String(before[key])} was updated, not removed`);
    return Object.keys(before).filter(
      (field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]),
    );
  });

test("accounts connected under the catalog app's first declaration link to a second app after the GO, and nothing else moves", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const w = yield* world;
      // The catalog app's own sources, deployed through the real deploy path, retained the ref
      // its first declaration derived; its current declaration derives the family's.
      assert.notEqual(w.retained, w.family, "the catalog app kept its first ref");
      assert.equal(
        (yield* identify(catalogProvider(catalogSource("cloudflare")))).identity,
        w.family,
      );
      assert.equal((yield* identify(providers.cloudflare)).identity, w.family);
      // Existing app lineages keep their ref when this declaration changes, so a change needs an
      // explicit adoption of the refs it leaves behind before new apps can share those accounts.
      assert.equal(
        w.family,
        "prv_889b2b58030f973c969bc67d076bb0e6f584e026f443a4f8a3e3c8b6175ba5f4",
        "the Cloudflare family's provider ref changed; ship an adoption for the previous ref",
      );
      assert.equal(
        (yield* identify(catalogProvider(catalogSource("cloudflare.published")))).identity,
        w.retained,
        "the retained ref is the one the first published declaration derived",
      );
      // The deciding input: what the deploys stored under the retained ref is the merge of both
      // declarations, and it derives the family's identity.
      const [stored] = yield* sql<{
        definition: unknown;
      }>`select definition from executor_providers where id = ${w.retained}`;
      assert.equal((yield* identifyStored(stored!.definition)).identity, w.family);
      assert.equal(yield* w.requirement(w.versionsB[1]!), w.retained, "team B kept the same ref");
      assert.equal(yield* link(w.pipeline, "acc_token"), "RequirementMismatch:provider");
      assert.deepEqual(yield* listed(w.pipeline), []);

      const before = yield* everything;
      const reviewedB = yield* dryRun(w.requestB);
      const { dry, plan, go } = yield* dryRun(w.requestA);
      assert.deepEqual(yield* everything, before, "dry runs write nothing");
      assert.equal(yield* link(w.pipeline, "acc_token"), "RequirementMismatch:provider");
      assert.equal(dry.changes, 6);
      assert.deepEqual(
        plan.changes.map((change) => [change.table, change.key, change.action]),
        [
          ["executor_accounts", { id: "acc_oauth" }, "update"],
          ["executor_accounts", { id: "acc_token" }, "update"],
          ...[...w.versionsA].sort().map((id) => ["executor_deployments", { id }, "update"]),
          ["executor_account_connections", { id: "con_token" }, "update"],
          ["executor_account_acquisitions", { account: "acc_oauth" }, "update"],
        ],
        "only team A's rows on the retained ref move",
      );
      assert.deepEqual(plan.data.apps, [{ app: w.toolA, version: w.versionsA[1] }]);
      assert.deepEqual(plan.data.joining, [{ app: w.pipeline, version: w.pipelineVersion }]);
      assert.deepEqual(plan.data.accounts, [
        { account: "acc_oauth", method: "oauth", generation: 1 },
        { account: "acc_token", method: "apiToken", generation: 3 },
      ]);
      assert.deepEqual(plan.data.links, [
        { app: w.toolA, requirement: "cloudflare", subject: "user-b", account: "acc_oauth" },
        { app: w.toolA, requirement: "cloudflare", subject: "user-a", account: "acc_token" },
      ]);

      const applied = yield* apply(go);
      assert.ok(applied.action === "apply" && applied.repeated === false);
      const after = yield* everything;
      const moved = changed(before, after);
      assert.deepEqual(
        Object.keys(moved).sort(),
        [
          "executor_account_acquisitions",
          "executor_account_connections",
          "executor_accounts",
          "executor_deployments",
          "private_production_ops_receipts",
        ],
        "providers, apps, links, access, identities, grants, clients and the queue are untouched",
      );
      assert.deepEqual(ids(moved.executor_accounts!.gone), ["acc_oauth", "acc_token"]);
      assert.deepEqual(fieldsChanged(moved.executor_accounts!), [["provider"], ["provider"]]);
      assert.deepEqual(ids(moved.executor_deployments!.gone), [...w.versionsA].sort());
      assert.deepEqual(fieldsChanged(moved.executor_deployments!), [
        ["requirements"],
        ["requirements"],
      ]);
      assert.deepEqual(ids(moved.executor_account_connections!.gone), ["con_token"]);
      assert.deepEqual(ids(moved.executor_account_acquisitions!.gone, "account"), ["acc_oauth"]);
      assert.deepEqual(fieldsChanged(moved.executor_account_acquisitions!, "account"), [
        ["provider"],
      ]);
      assert.equal(moved.private_production_ops_receipts!.added.length, 1);
      assert.deepEqual(
        yield* sql`select id, provider, credential_generation, identity_id, oauth_grant_id from executor_accounts order by id`,
        [
          {
            id: "acc_jira",
            provider: w.other,
            credential_generation: 1,
            identity_id: null,
            oauth_grant_id: null,
          },
          {
            id: "acc_oauth",
            provider: w.family,
            credential_generation: 1,
            identity_id: "aid_oauth",
            oauth_grant_id: "grt_oauth",
          },
          {
            id: "acc_team_b",
            provider: w.retained,
            credential_generation: 1,
            identity_id: null,
            oauth_grant_id: null,
          },
          {
            id: "acc_token",
            provider: w.family,
            credential_generation: 3,
            identity_id: null,
            oauth_grant_id: null,
          },
        ],
        "accounts keep their IDs, credentials, identity and grant; team B's stays on its ref",
      );

      // The step right after the GO: nothing in team A names the retained ref any more.
      const settled = yield* dryRun({ ...w.requestA, accounts: [] });
      assert.equal(settled.dry.changes, 0, "a dry run with no accounts plans zero changes");

      assert.equal(yield* link(w.pipeline, "acc_token"), "linked");
      assert.deepEqual(yield* listed(w.pipeline), ["acc_oauth", "acc_token"]);
      assert.deepEqual(
        yield* listed(w.toolA),
        ["acc_oauth", "acc_token"],
        "the catalog app keeps them",
      );
      assert.deepEqual(yield* listed(w.toolB), ["acc_team_b"], "team B's app still offers its own");
      assert.equal(
        yield* link(w.pipeline, "acc_jira"),
        "RequirementMismatch:provider",
        "a different provider still refuses",
      );
      assert.deepEqual(
        yield* sql`select app, subject from hosted_app_account_links where account = 'acc_oauth'`,
        [{ app: w.toolA, subject: "user-b" }],
        "the second person's account is linked only for them",
      );

      // Team B's own adoption still plans exactly what it did before team A's GO.
      const laterB = yield* dryRun(w.requestB);
      assert.deepEqual(laterB.plan.changes, reviewedB.plan.changes);
      assert.deepEqual(laterB.plan.data, reviewedB.plan.data);

      const replay = yield* apply(go);
      assert.ok(
        replay.action === "apply" && replay.repeated === true,
        "replay verifies without writing",
      );
      assert.equal((yield* sql`select * from private_production_ops_receipts`).length, 1);
      assert.equal(
        yield* reasonOf(dryRun(w.requestA)),
        "account-set-changed",
        "a second GO cannot be planned",
      );
    }),
  ));

test("a run stopped between the dry run and the GO leaves everything as it was", () =>
  run(
    Effect.gen(function* () {
      const w = yield* world;
      const before = yield* everything;
      const { go } = yield* dryRun(w.requestA);
      // The operator stops here; the database is exactly as it was and no receipt exists.
      assert.deepEqual(yield* everything, before);
      const applied = yield* apply(go);
      assert.ok(
        applied.action === "apply" && applied.repeated === false,
        "the reviewed GO still applies",
      );
    }),
  ));

test("an error inside the GO leaves nothing behind, and the same GO applies once it is gone", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const w = yield* world;
      const before = yield* everything;
      const { go } = yield* dryRun(w.requestA);
      // Accounts and versions are written before connections, so this fails after the first writes.
      yield* sql.unsafe(`create function refuse_connection_write() returns trigger language plpgsql as $$
        begin raise exception 'connection write refused'; end $$`);
      yield* sql.unsafe(`create trigger refuse_connection_write before update on executor_account_connections
        for each row execute function refuse_connection_write()`);
      const failed = yield* reasonOf(apply(go));
      assert.notEqual(failed, "succeeded");
      assert.deepEqual(
        yield* everything,
        before,
        "accounts and versions are unchanged and no receipt exists",
      );
      yield* sql.unsafe("drop trigger refuse_connection_write on executor_account_connections");
      const applied = yield* apply(go);
      assert.ok(applied.action === "apply" && applied.repeated === false);
      assert.equal((yield* dryRun({ ...w.requestA, accounts: [] })).dry.changes, 0);
    }),
  ));

test("after the GO, a replay stays quiet while people keep using the moved accounts", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const w = yield* world;
      const { go } = yield* dryRun(w.requestA);
      yield* apply(go);
      // A token renewal and a rename, a refreshed acquisition and a retained connection.
      yield* sql`update executor_accounts set encrypted_credentials = ${new Uint8Array([9])},
        credential_generation = credential_generation + 1, label = 'Renamed' where id = 'acc_token'`;
      yield* sql`update executor_account_acquisitions set revision = 'r2' where account = 'acc_oauth'`;
      yield* sql`update executor_account_connections set expires_at = now() + interval '1 day' where id = 'con_token'`;
      assert.equal(yield* reasonOf(apply(go)), "succeeded", "the replay verifies the moved refs");
      // The catalog app later moves to a provider of its own; its links no longer resolve to the
      // family ref, but nothing names the retained one.
      const renamed = catalogSource("cloudflare").map((file) =>
        file.path === "index.ts"
          ? {
              ...file,
              content: file.content.replace('name: "Cloudflare",', 'name: "Cloudflare staging",'),
            }
          : file,
      );
      const moved = yield* w.redeploy(teamA, w.toolA, renamed);
      assert.notEqual(yield* w.requirement(moved.version.id), w.family);
      assert.equal(yield* reasonOf(apply(go)), "succeeded", "the replay still verifies");
      // A moved row that names the retained ref again still fails it.
      yield* sql`update executor_account_connections set provider = ${w.retained} where id = 'con_token'`;
      assert.equal(
        yield* reasonOf(apply(go)),
        "ProductionOperationRefused: Committed migration needs operator investigation",
      );
    }),
  ));
