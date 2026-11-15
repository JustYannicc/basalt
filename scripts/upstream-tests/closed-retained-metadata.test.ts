import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { appDirectoryPostgres } from "./app-directory-postgres-fixture.ts";
import { sdk } from "./provider-destinations-modules.ts";
import { closedRetainedBuilds } from "../../.upstream/packages/sdk/src/implementation/closed-retained-builds.ts";

test("public app reads expose retained status only for the exact active app and build", async () => {
  const listed = closedRetainedBuilds[0];
  assert.ok(listed);
  await appDirectoryPostgres(({ executor, sql }) =>
    Effect.gen(function* () {
      const owner = sdk.OwnerId.make("organization:retained-metadata-fixture");
      const app = sdk.AppId.make(listed.app);
      const other = sdk.AppId.make("app_retained_metadata_other");
      for (const id of [app, other]) {
        yield* sql`insert into executor_deployments (id,code,owner,build,requirements,created_at,source_commit,file_count)
        values (${`dpl_${id}`},${`code_${id}`},${owner},${listed.build},'{"accounts":{}}',now(),null,1)`;
        yield* sql`insert into executor_apps (id,code,repository,owner,name,slug,active_deployment,copied_from,created_at)
        values (${id},${`code_${id}`},null,${owner},${id},${id.replaceAll("_", "-")},${`dpl_${id}`},null,now())`;
      }
      const expected = { build: listed.build, reason: listed.reason };
      assert.deepEqual((yield* executor.apps.get({ owner, app })).unverifiedFramework, expected);
      assert.deepEqual(
        (yield* executor.apps.list({ owner })).find((row) => row.id === app)?.unverifiedFramework,
        expected,
      );
      assert.equal(
        (yield* executor.apps.get({ owner, app: other })).unverifiedFramework,
        undefined,
      );
      yield* sql`insert into executor_deployments (id,code,owner,build,requirements,created_at,source_commit,file_count)
      values ('dpl_rebuilt_fixture',${`code_${app}`},${owner},'bld_new_qualified_fixture','{"accounts":{}}',now(),null,1)`;
      yield* sql`update executor_apps set active_deployment='dpl_rebuilt_fixture' where id=${app}`;
      assert.equal((yield* executor.apps.get({ owner, app })).unverifiedFramework, undefined);
    }),
  );
});
