import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
  apply,
  catalogSource,
  dryRun,
  identify,
  identifyStored,
  link,
  listed,
  ownerOf,
  providers,
  run,
  teamA,
  worldFrom,
  type Files,
} from "./cloudflare-family-fixture.ts";

/** The scopes every Cloudflare declaration asked for before the issuer added billing. */
const baseline = JSON.parse(
  readFileSync(
    new URL("../../src/catalog/cloudflare.oauth-scope-baseline.json", import.meta.url),
    "utf8",
  ),
) as string[];
/** The catalog Cloudflare app as it was before its re-pin: today's files with the baseline list. */
const beforeRepin: Files = catalogSource("cloudflare").map((file) =>
  file.path === "cloudflare-scopes.ts"
    ? {
        ...file,
        content: `// The reviewed authorization-server scope catalog. Update with the OAuth metadata snapshot.\nexport const cloudflareOAuthScopes = [\n${baseline.map((scope) => `  ${JSON.stringify(scope)}`).join(",\n")}\n] as const;\n`,
      }
    : file,
);

test("accounts on the family ref the 403-scope declaration derived are adopted onto the 405-scope ref", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const w = yield* worldFrom(beforeRepin);
      // The ref saved Cloudflare accounts carry since the first adoption, and the ref the
      // re-pinned declaration derives; the catalog app and the pool provider derive the same.
      assert.equal(
        w.retained,
        "prv_723ba6038ee84547f30e619eae5d182081e413ff4088bf26c8d567c45facfa47",
      );
      assert.equal(
        w.family,
        "prv_889b2b58030f973c969bc67d076bb0e6f584e026f443a4f8a3e3c8b6175ba5f4",
      );
      assert.equal((yield* identify(providers.cloudflare)).identity, w.family);
      // The release grows what is stored under the old ref to the 405 list, so it derives the new
      // ref: the existing adoption's own condition for moving it.
      const [stored] = yield* sql<{
        definition: unknown;
      }>`select definition from executor_providers where id = ${w.retained}`;
      assert.equal((yield* identifyStored(stored!.definition)).identity, w.family);

      // After the release, a newly installed app saves one more account, on the new ref.
      yield* sql`insert into executor_accounts (id,owner,provider,method,label,encrypted_credentials,created_at,credential_generation,identity_id,oauth_grant_id)
        values ('acc_after',${ownerOf(teamA)},${w.family},'apiToken','acc_after',${new Uint8Array([9])},now(),1,null,null)`;
      yield* sql`insert into hosted_account_access values ('acc_after',${teamA},'personal','user-a',null)`;
      assert.equal(yield* link(w.pipeline, "acc_after"), "linked");
      // Until the adoption, that app sees only the account saved after the release.
      assert.deepEqual(yield* listed(w.pipeline), ["acc_after"]);
      assert.deepEqual(yield* listed(w.toolA), ["acc_oauth", "acc_token"]);

      const { dry, plan, go } = yield* dryRun(w.requestA);
      assert.ok((dry.changes ?? 0) > 0, "the dry run plans the move");
      assert.deepEqual(plan.data.accounts, [
        { account: "acc_oauth", method: "oauth", generation: 1 },
        { account: "acc_token", method: "apiToken", generation: 3 },
      ]);
      const applied = yield* apply(go);
      assert.ok(applied.action === "apply" && applied.repeated === false);

      assert.deepEqual(
        yield* sql`select id, provider, credential_generation from executor_accounts
          where owner = ${ownerOf(teamA)} and id <> 'acc_jira' order by id`,
        [
          { id: "acc_after", provider: w.family, credential_generation: 1 },
          { id: "acc_oauth", provider: w.family, credential_generation: 1 },
          { id: "acc_token", provider: w.family, credential_generation: 3 },
        ],
        "every account is on the new ref once, with its credentials untouched",
      );
      // Both apps now offer every Cloudflare account, and the existing app's links still hold.
      assert.deepEqual(yield* listed(w.pipeline), ["acc_after", "acc_oauth", "acc_token"]);
      assert.deepEqual(yield* listed(w.toolA), ["acc_after", "acc_oauth", "acc_token"]);
      assert.deepEqual(
        yield* sql`select app, account from hosted_app_account_links where app = ${w.toolA} order by account`,
        [
          { app: w.toolA, account: "acc_oauth" },
          { app: w.toolA, account: "acc_token" },
        ],
      );
      assert.equal(yield* link(w.toolA, "acc_after"), "linked");
      assert.equal(
        (yield* dryRun({ ...w.requestA, accounts: [] })).dry.changes,
        0,
        "nothing in the organization names the old ref any more",
      );
    }),
  ));
