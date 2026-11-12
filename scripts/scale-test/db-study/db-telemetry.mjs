import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
export function databaseSnapshot(id) {
  const query = `SELECT json_build_object(
 'at',extract(epoch FROM clock_timestamp())*1000,
 'database',(SELECT row_to_json(d) FROM (SELECT xact_commit,xact_rollback,blks_read,blks_hit,tup_returned,tup_fetched,tup_inserted,tup_updated,tup_deleted,temp_files,temp_bytes,deadlocks,blk_read_time,blk_write_time,sessions,sessions_abandoned,sessions_fatal,sessions_killed FROM pg_stat_database WHERE datname=current_database())d),
 'activity',(SELECT coalesce(json_agg(d),'[]'::json) FROM (SELECT state,wait_event_type,wait_event,count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name<>'fixture-monitor' GROUP BY state,wait_event_type,wait_event)d),
 'statements',(SELECT coalesce(json_agg(to_jsonb(s)||jsonb_build_object('queryid',s.queryid::text)),'[]'::json) FROM pg_stat_statements s WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()))
 )`;
  const result = spawnSync(
    "docker",
    [
      "exec",
      "--env",
      "PGAPPNAME=fixture-monitor",
      id,
      "psql",
      "-X",
      "-q",
      "-A",
      "-t",
      "-U",
      "fixture_admin",
      "-d",
      "basalt_pool",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      query,
    ],
    { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 2 ** 20 },
  );
  if (result.status !== 0) throw Error("Isolated PostgreSQL snapshot failed");
  return JSON.parse(result.stdout.trim());
}
export function startDatabaseObserver(root, out, id, observers) {
  const stream = createWriteStream(join(out, "postgres-resources.ndjson"));
  const child = spawn(process.execPath, [join(root, "db-observe.mjs"), id], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stream);
  child.stderr.on("data", (chunk) =>
    stream.write(JSON.stringify({ at: Date.now(), error: chunk.toString() }) + "\n"),
  );
  child.once("exit", () => stream.end());
  observers.push(child);
}
export function statementDeltas(before, after) {
  const identity = (row) => JSON.stringify([row.userid, row.dbid, row.toplevel, row.queryid]);
  const baseline = new Map(before.statements.map((row) => [identity(row), row]));
  return after.statements
    .map((row) => {
      const previous = baseline.get(identity(row)),
        calls = row.calls - (previous?.calls ?? 0);
      return {
        ...row,
        callsDelta: calls,
        rowsDelta: row.rows - (previous?.rows ?? 0),
        execMsDelta: row.total_exec_time - (previous?.total_exec_time ?? 0),
      };
    })
    .filter((row) => row.callsDelta > 0 && !row.query.includes("pg_stat_statements"));
}
