import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SharingFixture } from "./sharing-fixture.ts";

const step = "diagnostics_metadata_only_v1_1_6";
const response = "private-app-log-response-329";
const token = "private-app-log-token-481";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const appLog = {
  line: `devin executor: trailer error (7): ${response}, Authorization: Bearer ${token}`,
  level: "warning", timestamp: "2026-10-29T12:00:00Z", request_id: token,
};

test("app-log privacy upgrades a completed usage journal and guards response-bearing old writes", { timeout: 180_000 }, async () => {
  const baseline = process.env.POOL_TEST_USAGE_PRIVACY_IMAGE, candidate = process.env.POOL_TEST_IMAGE;
  assert.ok(baseline && candidate, "Build the #105 baseline and candidate images before the app-log proof");
  const fixture = new SharingFixture({ image: baseline, resourcePrefix: "basalt-app-log-privacy", postgresDataStorage: "volume" });
  try {
    await fixture.start();
    await fixture.diagnostics.waitForPrivacy();
    fixture.diagnostics.pushAppLog(appLog);
    const source = Number(fixture.diagnostics.sql(`select min(id) from log where strpos(line,${quote(response)})>0`));
    assert.ok(source, "The #105 baseline must reproduce response-bearing application-log storage");
    fixture.diagnostics.sql(`insert into log (timestamp,client_ip,request_id,home_ip,level,line,created_at)
      select timestamp,client_ip,request_id,home_ip,level,line,created_at
      from log cross join generate_series(1,202) where id=${source}`);
    const historicalMax = Number(fixture.diagnostics.sql("select max(id) from log"));
    assert.equal(fixture.diagnostics.sql(`select count(*) from log where strpos(line,${quote(response)})>0`), "203");
    const usageReceipt = fixture.diagnostics.sql(`select rows_scanned,token_copies,matched_active_api_key_copies from home_data_migration_audit where name=${quote(step)}`);
    assert.equal(fixture.diagnostics.sql(`select (completed and audit_marker_emitted)::int from home_data_migration where name=${quote(step)}`), "1");
    console.log("PASS: #105 baseline stores the response-bearing app log after its usage purge completed");
    fixture.diagnostics.sql(`create table fixture_app_log_fault (enabled boolean not null);
      insert into fixture_app_log_fault values (true);
      create function fixture_fail_app_log_batch() returns trigger language plpgsql as $$ begin
        if current_setting('application_name')='home-privacy-maintenance' then
          if (select enabled from fixture_app_log_fault limit 1) then raise exception 'fixture app-log batch failure'; end if;
          perform pg_sleep(0.005);
        end if;
        return new;
      end $$;
      create trigger z_fixture_app_log_fault before update on log for each row execute function fixture_fail_app_log_batch();`);
    const startup = Date.now();
    await fixture.replaceImage(candidate);
    assert.ok(Date.now() - startup < 30_000, "App-log cleanup must stay off the serving boot path");
    assert.equal(fixture.diagnostics.sql("select version from home_schema_migration where id=1"), "13",
      "The completed #105 schema must advance before the app-log worker uses its new journal columns");
    let retrySeen = false;
    for (let index = 0; index < 80; index++) {
      if ((await fixture.captureContainerLogs()).pool.includes("POOL_PRIVACY_RETRY ")) { retrySeen = true; break; }
      await delay(200);
    }
    assert.ok(retrySeen, "Failed app-log batches must remain visible while serving continues");
    fixture.diagnostics.pushAppLog(appLog);
    fixture.diagnostics.sql(`insert into log (timestamp,client_ip,request_id,home_ip,level,line,created_at)
      values (now(),${quote(token)},${quote(token)},${quote(token)},${quote(response)},${quote(response)},now());
      update log set line=${quote(response)},request_id=${quote(token)},level=${quote(response)} where id=(select max(id) from log)`);
    assert.equal(fixture.diagnostics.sql(`select count(*) from log t where id>${historicalMax} and
      (strpos(row_to_json(t)::text,${quote(response)})>0 or strpos(row_to_json(t)::text,${quote(token)})>0)`), "0",
    "Ingestion and the old-writer guard must remove content from new app logs before historical cleanup");
    fixture.diagnostics.sql("update fixture_app_log_fault set enabled=false");
    let partial = 0;
    for (let index = 0; index < 100; index++) {
      partial = Number(fixture.diagnostics.sql(`select app_log_rows_updated from home_data_migration where name=${quote(step)}`));
      if (partial > 0) break;
      await delay(100);
    }
    assert.ok(partial > 0 && partial < 203, "App-log progress must commit before cleanup finishes and the process crashes");
    assert.ok(!(await fixture.captureContainerLogs()).pool.includes("POOL_APP_LOG_PRIVACY_AUDIT "));
    await fixture.crashAndReplace(candidate);
    await fixture.diagnostics.waitForAppLogPrivacy();
    const [processed, bound] = fixture.diagnostics.sql(`select app_log_rows_updated,app_log_max_id from home_data_migration where name=${quote(step)}`).split("|").map(Number);
    assert.ok(typeof processed === "number" && Number.isSafeInteger(processed) && processed >= 203);
    assert.ok(typeof bound === "number" && Number.isSafeInteger(bound) && bound >= 203);
    assert.equal(processed, Number(fixture.diagnostics.sql(`select count(*) from log where id<=${bound}`)),
      "Restart must count each bounded historical app-log row exactly once");
    assert.equal(fixture.diagnostics.sql(`select rows_scanned,token_copies,matched_active_api_key_copies from home_data_migration_audit where name=${quote(step)}`), usageReceipt,
      "Extending the journal must preserve the #105 usage audit receipt");
    let logs = (await fixture.captureContainerLogs()).pool;
    for (let index = 0; index < 50 && !logs.includes("POOL_APP_LOG_PRIVACY_AUDIT "); index++) {
      await delay(100);
      logs = (await fixture.captureContainerLogs()).pool;
    }
    assert.equal((logs.match(/POOL_APP_LOG_PRIVACY_AUDIT /g) ?? []).length, 1);
    assert.equal((logs.match(/POOL_PRIVACY_AUDIT /g) ?? []).length, 0, "The earlier usage audit must not be emitted again");
    assert.deepEqual(await fixture.diagnostics.scan([response, token]), { database: 0, files: 0, logs: 0 });
    await fixture.replaceImage(candidate);
    await fixture.diagnostics.waitForAppLogPrivacy();
    assert.equal(fixture.diagnostics.sql(`select app_log_rows_updated from home_data_migration where name=${quote(step)}`), String(processed));
    assert.ok(!(await fixture.captureContainerLogs()).pool.includes("POOL_APP_LOG_PRIVACY_AUDIT "), "Repeated boot must not duplicate the app-log receipt");
    console.log("PASS: response-bearing app logs are projected, guarded and purged with bounded restart-safe counts");
  } catch (error) {
    console.log("APP_LOG_PRIVACY_FAILURE_HEALTH " + JSON.stringify(fixture.diagnostics.failureHealth()));
    throw error;
  } finally {
    await fixture.close();
  }
});
