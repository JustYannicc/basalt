import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeClient, PoolHome } from "../../src/pool/control.ts";
import { SharingFixture, type HomeProvider } from "./sharing-fixture.ts";

const step = "diagnostics_metadata_only_v1_1_6";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

test("large historical cleanup serves through failed batches and resumes after SIGKILL", { timeout: 600_000 }, async () => {
  const legacy = process.env.POOL_TEST_LEGACY_IMAGE, candidate = process.env.POOL_TEST_IMAGE;
  assert.ok(legacy && candidate, "Build legacy and candidate pool images before the background proof");
  const fixture = new SharingFixture({ image: legacy, resourcePrefix: "basalt-privacy-background",
    failureContent: "fail-request-private-background-prompt-173", failureResponse: "private-background-response-269" });
  try {
    await fixture.start();
    const client = new HomeClient((path, init) => fixture.fetchHome(path, init));
    const providers = await fixture.data<HomeProvider[]>("/config/api-keys/openai-compatibility");
    await new PoolHome(client, "privacy-background").add([providers.find((provider) => provider.name === "fixture-p1")!.keys[0]!.id]);
    const key = await new ComputerHome(client).mint("privacy-background-person", "privacy-background", "privacy-background-computer");
    const response = await fixture.model(key.key, "privacy-background-seed", "fail");
    assert.equal(response.status, 400);
    await response.text();
    let source = 0;
    for (let index = 0; index < 150; index++) {
      source = Number(fixture.diagnostics.sql("select coalesce(min(id),0) from usage where failed=true"));
      if (source) break;
      await delay(200);
    }
    assert.ok(source, "Released image must persist the historical failure fixture");
    fixture.diagnostics.sql(`do $$ declare columns text; selected text; begin
      select string_agg(format('%I',attname),','), string_agg(format('u.%I',attname),',') into columns,selected
      from pg_attribute where attrelid='usage'::regclass and attnum>0 and not attisdropped and attname<>'id' and attgenerated='';
      execute format('insert into usage (%s) select %s from usage u cross join generate_series(1,20000) where u.id=%s',columns,selected,${source});
    end $$;`);
    console.log("PASS: historical usage rows seeded");
    fixture.diagnostics.sql(`create function fixture_privacy_visible(row_id bigint) returns boolean language plpgsql volatile as $$ begin
      if current_setting('application_name')='home-privacy-maintenance' then perform pg_sleep(0.002); end if;
      return true;
    end $$;
    alter table usage enable row level security;
    alter table usage force row level security;
    create policy fixture_privacy_latency on usage using (fixture_privacy_visible(id));`);
    console.log("PASS: historical read latency policy installed");
    // PostgreSQL's initdb bootstrap role cannot lose SUPERUSER. Give this
    // disposable database a separate owner so both Home and the probe use RLS.
    fixture.diagnostics.sql(`create role fixture_runtime login password 'fixture-only';
      alter database basalt_pool owner to fixture_runtime;
      alter schema public owner to fixture_runtime;
      do $$ declare item record; begin
        for item in select tablename from pg_tables where schemaname='public' loop
          execute format('alter table public.%I owner to fixture_runtime',item.tablename);
        end loop;
      end $$;`);
    fixture.useDatabaseRole("fixture_runtime");
    console.log("PASS: non-superuser fixture owner enforces the latency policy");
    // A database-side latency bound makes this independent of runner speed. The
    // same row policy applies to real cleanup transactions tagged by Home.
    assert.ok(fixture.diagnostics.statementTimesOut("select count(*) from usage;", "fixture_runtime"), "A whole-table audit cannot fit its former 30-second transaction");
    console.log("PASS: 20,001-row history exceeds the former single-transaction audit deadline");
    fixture.diagnostics.sql(`create table fixture_privacy_fault (enabled boolean not null);
      insert into fixture_privacy_fault values (true);
      create function fixture_privacy_fail_batch() returns trigger language plpgsql as $$ begin
        if current_setting('application_name')='home-privacy-maintenance' and (select enabled from fixture_privacy_fault limit 1)
          then raise exception 'fixture transient batch failure'; end if;
        return new;
      end $$;
      create trigger z_fixture_privacy_fail before update on usage for each row execute function fixture_privacy_fail_batch();`);
    const startup = Date.now();
    await fixture.replaceImage(candidate);
    assert.ok(Date.now() - startup < 30_000, "Serving must start while the historical purge is still blocked");
    const models = await fetch(`${fixture.node}/v1/models`, { headers: { Authorization: `Bearer ${key.key}` }, signal: AbortSignal.timeout(3_000) });
    assert.equal(models.status, 200);
    const blocked = fixture.diagnostics.sql(`select completed::int from home_data_migration where name=${quote(step)}`);
    assert.equal(blocked, "0", "Readiness must not wait for purge completion");
    let retrySeen = false;
    for (let index = 0; index < 80; index++) {
      if ((await fixture.captureContainerLogs()).pool.includes("POOL_PRIVACY_RETRY ")) { retrySeen = true; break; }
      await delay(200);
    }
    assert.ok(retrySeen, "Failed background batches must surface through the supervisor");
    const served = await fixture.model(key.key, "privacy-background-serving");
    assert.equal(served.status, 200);
    await served.text();
    let servingUsage = false;
    for (let index = 0; index < 100; index++) {
      if (fixture.diagnostics.sql("select count(*) from usage") === "20002") { servingUsage = true; break; }
      await delay(200);
    }
    assert.ok(servingUsage, "The live request must reach durable usage before the crash");
    fixture.diagnostics.sql("update fixture_privacy_fault set enabled=false");
    let partial = 0;
    for (let index = 0; index < 200; index++) {
      partial = Number(fixture.diagnostics.sql(`select usage_rows_updated from home_data_migration where name=${quote(step)} and completed=false`));
      if (partial > 0) break;
      await delay(200);
    }
    assert.ok(partial > 0 && partial < 20_001, "A bounded batch must commit before the crash");
    const before = await fixture.captureContainerLogs();
    assert.ok(!before.pool.includes("POOL_PRIVACY_AUDIT "), "No final audit is emitted during partial work");
    await fixture.crashAndReplace(candidate);
    assert.equal((await fetch(`${fixture.node}/v1/models`, { headers: { Authorization: `Bearer ${key.key}` }, signal: AbortSignal.timeout(3_000) })).status, 200);
    await fixture.diagnostics.waitForPrivacy(420_000);
    fixture.diagnostics.sql("drop policy fixture_privacy_latency on usage; alter table usage disable row level security");
    const counts = fixture.diagnostics.sql(`select rows_scanned,matched_active_api_key_copies,active_api_key_count
      from home_data_migration_audit where name=${quote(step)}`).split("|").map(Number);
    assert.equal(counts[0], 20_001, "Resume counts each historical row exactly once");
    assert.equal(counts[1], 40_002, "Both historical token copies are counted across restarts");
    assert.equal(counts[2], 1, "Distinct credentials are not counted again in each batch");
    assert.equal(fixture.diagnostics.sql("select count(*) from usage"), "20002", "Serving and purge preserve all usage rows");
    let after = await fixture.captureContainerLogs();
    for (let index = 0; index < 50 && !after.pool.includes("POOL_PRIVACY_AUDIT "); index++) {
      await delay(200);
      after = await fixture.captureContainerLogs();
    }
    assert.equal((after.pool.match(/POOL_PRIVACY_AUDIT /g) ?? []).length, 1, "The resumed job emits one final counts-only audit");
    assert.deepEqual(await fixture.diagnostics.scan([key.key, "fail-request-private-background-prompt-173", "private-background-response-269"]),
      { database: 0, files: 0, logs: 0 });
    console.log("PASS: serving starts before cleanup, retries surface, and SIGKILL resumes without losing or duplicating audit counts");
  } finally {
    await fixture.close();
  }
});
