// One-off finish for a staged bulk history import whose per-row path is too slow for its primary.
// The app's parser and insert, commitBulkChunk's statements, the job's normal receipts; the only
// change is that the history live-change row trigger skips this session and each transaction
// invalidates the pool once (history-import-finish-store.ts).
//   check      read-only: identity, boundary, privileges, trigger shape
//   load       commit the remaining rows (--guard-file from the single metrics reader, --control-file pause)
//   finalize   VACUUM (ANALYZE) + CHECKPOINT, while the primary is still large
//   verify     read-only: receipts and every manifest id against the database
//   guard-install / guard-restore   path B trigger swap; each needs its own operator GO
// A critical or error stop writes <state-dir>/STOP; load refuses until an operator removes it.
import { parseArgs } from "node:util";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { readDescriptor, bulkChunks, hash } from "./usage-import-bulk.ts";
import { parseBulkChunk } from "../src/pool/model-history/bulk-parser.ts";
import {
  decide,
  diskHeadroom,
  errorSummary,
  isConnectionReset,
  type FinishGuardState,
} from "./history-import-finish-guard.ts";
import {
  bypasses,
  commitFinish,
  committedRows,
  guardSetting,
  jobMatches,
  swapTrigger,
  triggerDefinition,
  triggerShape,
  type Bypass,
} from "./history-import-finish-store.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    descriptor: { type: "string" },
    "database-url-file": { type: "string" },
    "state-dir": { type: "string" },
    "guard-file": { type: "string" },
    "control-file": { type: "string" },
    bypass: { type: "string" },
    rows: { type: "string", default: "5000" },
    "pace-ms": { type: "string", default: "5000" },
    "set-role": { type: "string", default: "basalt_pool_owner" },
    "expect-inserted": { type: "string" },
    "expect-existing": { type: "string" },
    // Heap plus 6 index families per history row, measured locally at ~1.1 KB; doubled for margin.
    "bytes-per-row": { type: "string", default: "2048" },
  },
});
const need = (name: keyof typeof values) => {
  const value = values[name];
  if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
  return value;
};
const descriptor = await readDescriptor(need("descriptor"));
const def = descriptor.definition;
const stateDir = need("state-dir");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const stopFile = `${stateDir}/STOP`;
const now = () => new Date().toISOString();
const minRows = 1000,
  maxRows = 5000;
const log = (event: Record<string, unknown>) => {
  const line = JSON.stringify({ at: now(), ...event });
  console.log(line);
  appendFileSync(`${stateDir}/events.jsonl`, line + "\n", { mode: 0o600 });
};
const mirror = (status: Record<string, unknown>) => {
  writeFileSync(
    `${stateDir}/status.json.tmp`,
    JSON.stringify({ at: now(), job: def.job, ...status }, null, 1),
    { mode: 0o600 },
  );
  renameSync(`${stateDir}/status.json.tmp`, `${stateDir}/status.json`);
};
const pieceMatches = (
  piece: { data: string; ids: string[] },
  chunk: { sha256: string; idsSha256: string },
) => hash(piece.data) === chunk.sha256 && hash(JSON.stringify(piece.ids)) === chunk.idsSha256;
const readJson = (path: string | undefined): unknown => {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { unreadable: true };
  }
};

/** A direct primary session (not the transaction pooler), so SET LOCAL stays with its transaction. */
class Session {
  client: pg.Client | null = null;
  lost: unknown = null;
  readonly queryTimeoutMs: number | null;
  // A client-side bound catches half-open sockets after a cutover; maintenance passes null to run without it.
  constructor(queryTimeoutMs: number | null = 30_000) {
    this.queryTimeoutMs = queryTimeoutMs;
  }
  async get() {
    if (this.client && !this.lost) return this.client;
    await this.close();
    const client = new pg.Client({
      connectionString: readFileSync(need("database-url-file"), "utf8").trim(),
      keepAlive: true,
      connectionTimeoutMillis: 10_000,
      query_timeout: this.queryTimeoutMs ?? undefined,
    });
    // An idle drop (resize cutover) must not crash the process; the next transaction reconnects.
    client.on("error", (error) => {
      if (this.client === client) this.lost = error;
    });
    await client.connect();
    this.lost = null;
    this.client = client;
    if (values["set-role"])
      await client.query(`SET ROLE ${client.escapeIdentifier(values["set-role"])}`);
    return client;
  }
  drop(error: unknown) {
    this.lost = error;
  }
  async close() {
    await this.client?.end().catch(() => {});
    this.client = null;
  }
}

async function check() {
  const session = new Session();
  try {
    const db = await session.get();
    const facts = (
      await db.query(`SELECT session_user, current_user, current_setting('server_version') AS version,
      current_setting('session_replication_role') AS replication_role,
      has_parameter_privilege(session_user, 'session_replication_role', 'SET') AS session_user_can_set_replication_role,
      has_parameter_privilege('session_replication_role', 'SET') AS current_user_can_set_replication_role,
      pg_has_role(session_user, 'basalt_pool_owner', 'SET') AS can_set_owner,
      pg_has_role(session_user, 'pg_checkpoint', 'USAGE') AS can_checkpoint`)
    ).rows[0];
    const job = (
      await db.query(
        `SELECT pool,organization,owner,manifest_digest,map_digest,total_rows::text,total_chunks
      FROM basalt_model_import_jobs WHERE id=$1`,
        [def.job],
      )
    ).rows[0];
    const identity = jobMatches(job, def);
    const committed = await committedRows(db, def.job);
    let processed = 0,
      full = 0;
    for (const [chunk, rows] of committed) {
      processed += rows;
      if (rows === def.manifest.chunks[chunk]?.rows) full++;
    }
    const result = {
      ...facts,
      identity,
      processed,
      fullChunks: full,
      partialChunks: committed.size - full,
      trigger: triggerShape(await triggerDefinition(db)),
      stopLatched: existsSync(stopFile),
    };
    log({ check: result });
    mirror({ state: "checked", ...result });
  } finally {
    await session.close();
  }
}

/**
 * The one retry after a dropped connection. The old backend can outlive the socket (a COMMIT still
 * waiting on a standby) and keep the writer lock, so only "writer busy" and lock timeouts wait, up to
 * 60 s; the receipt check then replays a commit that did land. Any other failure stops.
 */
async function retryAfterReset(
  session: Session,
  index: number,
  start: number,
  part: Parameters<typeof commitFinish>[4],
  bypass: Bypass,
) {
  for (let attempt = 1; ; attempt++) {
    await sleep(attempt === 1 ? 5000 : 10_000);
    try {
      return await commitFinish(await session.get(), def, index, start, part, bypass);
    } catch (error) {
      const busy =
        /writer is busy/.test(String((error as Error).message)) ||
        (error as { code?: unknown }).code === "55P03";
      if (!busy || attempt >= 6) throw error;
      log({ retryWait: { chunk: index, start, attempt, error: errorSummary(error) } });
    }
  }
}

async function load() {
  const bypass = need("bypass") as Bypass;
  const paceMs = Number(values["pace-ms"]);
  let size = Number(values.rows);
  const session = new Session();
  const guard: FinishGuardState = { throttled: false, criticalSince: null, lastAt: null };
  const run = {
    processed: 0,
    inserted: 0,
    existing: 0,
    chunk: -1,
    start: 0,
    retries: 0,
    lastElapsedMs: null as number | null,
    lastCommitAt: null as string | null,
  };
  const startedAt = Date.now();
  let observation: unknown = null;
  const status = (state: string, extra: Record<string, unknown> = {}) => {
    const o = observation as { cpu?: unknown; observedAt?: unknown } | null;
    mirror({
      state,
      bypass,
      totalRows: def.manifest.totalRows,
      ...run,
      rowsPerTxn: size,
      rowsPerSecond: Math.round(
        ((run.inserted + run.existing) * 1000) / Math.max(1, Date.now() - startedAt),
      ),
      guard: o
        ? { cpu: o.cpu, ageS: Math.round((Date.now() - Date.parse(String(o.observedAt))) / 1000) }
        : null,
      ...extra,
    });
  };
  // Refusals before any database work leave the latch and status untouched.
  if (existsSync(stopFile))
    throw new Error(
      `A durable stop is latched (${readFileSync(stopFile, "utf8").trim()}); an operator must clear it`,
    );
  if (!bypasses.includes(bypass)) throw new Error(`--bypass must be one of ${bypasses.join(", ")}`);
  if (!(size >= minRows && size <= maxRows) || !(paceMs >= 0))
    throw new Error("Invalid --rows or --pace-ms");
  let outcome: { state: string; reason: string | null } = { state: "completed", reason: null };
  try {
    const db = await session.get();
    const shape = triggerShape(await triggerDefinition(db));
    if (bypass === "guarded" && shape !== "guarded")
      throw new Error(`History trigger is ${shape}, guarded expected`);
    if (
      bypass === "replica" &&
      !(await db.query("SELECT has_parameter_privilege('session_replication_role','SET') AS ok"))
        .rows[0].ok
    )
      throw new Error("The import role cannot set session_replication_role");
    const committed = await committedRows(db, def.job);
    run.processed = [...committed.values()].reduce((a, b) => a + b, 0);
    const disk = readJson(values["guard-file"]) as {
      capacityBytes?: unknown;
      usedBytes?: unknown;
    } | null;
    if (typeof disk?.capacityBytes !== "number" || typeof disk.usedBytes !== "number")
      throw new Error("Guard file has no volume capacity for the headroom check");
    const walBudget = Number(
      (
        await db.query(
          "SELECT setting::bigint * 1024 * 1024 AS b FROM pg_settings WHERE name='max_wal_size'",
        )
      ).rows[0].b,
    );
    const headroom = diskHeadroom(
      { capacityBytes: disk.capacityBytes, usedBytes: disk.usedBytes },
      walBudget,
      def.manifest.totalRows - run.processed,
      Number(values["bytes-per-row"]),
    );
    log({ headroom: { ...headroom, walBudget } });
    if (!headroom.ok)
      throw new Error(
        `Disk headroom: ${headroom.needed} bytes needed, ${headroom.limit} allowed (50% of the volume)`,
      );
    status("starting");
    outer: for await (const piece of bulkChunks(descriptor.files)) {
      const index = ++run.chunk;
      const chunk = def.manifest.chunks[index]!;
      if (!pieceMatches(piece, chunk)) throw new Error(`Chunk ${index} differs from the manifest`);
      run.start = committed.get(index) ?? 0;
      if (run.start === chunk.rows) continue;
      const records = await parseBulkChunk(def, index, piece.data);
      while (run.start < records.length) {
        for (;;) {
          if ((readJson(values["control-file"]) as { pause?: unknown } | null)?.pause === true) {
            outcome = { state: "paused", reason: "operator_paused" };
            break outer;
          }
          observation = readJson(values["guard-file"]);
          const decision = decide(guard, observation, Date.now());
          if (decision.kind === "go") break;
          if (decision.kind === "pause") {
            outcome = { state: "paused", reason: decision.reason };
            break outer;
          }
          if (decision.kind === "stop") {
            outcome = { state: "stopped", reason: decision.reason };
            break outer;
          }
          status("waiting", { reason: decision.reason });
          await sleep(5000);
        }
        const txnAt = Date.now();
        const part = records.slice(run.start, run.start + size);
        let result;
        try {
          result = await commitFinish(await session.get(), def, index, run.start, part, bypass);
        } catch (error) {
          if (!isConnectionReset(error)) throw error;
          run.retries++;
          log({ retry: { chunk: index, start: run.start, error: errorSummary(error) } });
          session.drop(error);
          result = await retryAfterReset(session, index, run.start, part, bypass);
        }
        log({
          receipt: {
            chunk: index,
            start: run.start,
            rows: part.length,
            inserted: result.inserted,
            existing: result.existing,
            elapsedMs: result.elapsedMs,
            replayed: result.replayed,
          },
        });
        run.start += part.length;
        run.processed += part.length;
        run.inserted += result.inserted;
        run.existing += result.existing;
        run.lastElapsedMs = result.elapsedMs;
        run.lastCommitAt = now();
        // Over 3 s means slow down, so a cutover or failover never waits on a long transaction.
        if (result.elapsedMs > 3000 && size > minRows)
          size = Math.max(minRows, Math.floor(size / 2));
        status("running");
        await sleep(Math.max(0, txnAt + Math.round((paceMs * part.length) / maxRows) - Date.now()));
      }
    }
    if (outcome.state === "completed" && run.processed !== def.manifest.totalRows)
      throw new Error(`Processed ${run.processed} of ${def.manifest.totalRows}`);
  } catch (error) {
    outcome = { state: "stopped", reason: "error" };
    log({ error: errorSummary(error) });
  } finally {
    await session.close();
  }
  if (outcome.state === "stopped")
    writeFileSync(stopFile, JSON.stringify({ at: now(), reason: outcome.reason }) + "\n", {
      mode: 0o600,
    });
  status(outcome.state, { reason: outcome.reason });
  log({ end: outcome, processed: run.processed, inserted: run.inserted, existing: run.existing });
  process.exitCode = outcome.state === "completed" ? 0 : outcome.state === "paused" ? 2 : 1;
}

async function finalize() {
  const session = new Session(null);
  try {
    const db = await session.get();
    await db.query("SET statement_timeout = 0");
    for (const table of [
      "basalt_model_requests",
      "basalt_model_import_receipts",
      "basalt_pool_change_heads",
      "basalt_pool_change_pending",
      "basalt_pool_change_dirty",
      "basalt_pool_change_batches",
    ]) {
      if (!(await db.query("SELECT to_regclass($1) IS NOT NULL AS ok", [table])).rows[0].ok)
        continue;
      const at = Date.now();
      await db.query(`VACUUM (ANALYZE) ${table}`);
      log({ vacuum: table, ms: Date.now() - at });
    }
    await db.query("RESET ROLE");
    const at = Date.now();
    await db.query("CHECKPOINT");
    log({ checkpoint: Date.now() - at });
    mirror({ state: "finalized" });
  } finally {
    await session.close();
  }
}

async function verify() {
  const session = new Session();
  try {
    const db = await session.get();
    await db.query("BEGIN READ ONLY");
    const committed = await committedRows(db, def.job);
    const receipts = (
      await db.query(
        `SELECT chunk,start_row,rows,input_sha,ids_sha,inserted,existing FROM basalt_model_import_receipts
      WHERE job=$1 ORDER BY chunk,start_row`,
        [def.job],
      )
    ).rows;
    const problems: string[] = [];
    const cursor = new Map<number, number>();
    let inserted = 0,
      existing = 0,
      present = 0,
      index = -1;
    for (const r of receipts) {
      const chunk = def.manifest.chunks[Number(r.chunk)];
      if (!chunk || r.input_sha !== chunk.sha256 || r.ids_sha !== chunk.idsSha256)
        problems.push(`receipt digest ${r.chunk}`);
      if ((cursor.get(Number(r.chunk)) ?? 0) !== Number(r.start_row))
        problems.push(`receipt gap ${r.chunk}:${r.start_row}`);
      cursor.set(Number(r.chunk), Number(r.start_row) + Number(r.rows));
      if (Number(r.inserted) + Number(r.existing) !== Number(r.rows))
        problems.push(`receipt counts ${r.chunk}:${r.start_row}`);
      inserted += Number(r.inserted);
      existing += Number(r.existing);
    }
    def.manifest.chunks.forEach((chunk, i) => {
      if (committed.get(i) !== chunk.rows)
        problems.push(`chunk ${i} committed ${committed.get(i) ?? 0}/${chunk.rows}`);
    });
    for await (const piece of bulkChunks(descriptor.files)) {
      const chunk = def.manifest.chunks[++index]!;
      if (!pieceMatches(piece, chunk)) problems.push(`staged chunk ${index} changed`);
      present += Number(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM basalt_model_requests WHERE id=ANY($1::text[])",
            [piece.ids],
          )
        ).rows[0].n,
      );
    }
    await db.query("COMMIT");
    if (present !== def.manifest.totalRows)
      problems.push(`manifest ids present ${present}/${def.manifest.totalRows}`);
    for (const [flag, actual] of [
      ["expect-inserted", inserted],
      ["expect-existing", existing],
    ] as const)
      if (values[flag] !== undefined && Number(values[flag]) !== actual)
        problems.push(`${flag} ${values[flag]} != ${actual}`);
    const result = {
      receipts: receipts.length,
      inserted,
      existing,
      processed: inserted + existing,
      manifestIdsPresent: present,
      totalRows: def.manifest.totalRows,
      problemCount: problems.length,
      problems: problems.slice(0, 20),
    };
    log({ verify: result });
    mirror({ state: problems.length ? "verify_failed" : "verified", ...result });
    if (problems.length) process.exitCode = 1;
  } finally {
    await session.close();
  }
}

async function swap(install: boolean) {
  const session = new Session();
  const saved = `${stateDir}/trigger-original.sql`;
  try {
    const db = await session.get();
    if (install) {
      // Saved before the swap, so a crash after COMMIT still leaves the exact original on disk.
      const before = await triggerDefinition(db);
      if (triggerShape(before) !== "original")
        throw new Error(`History trigger is ${triggerShape(before)}, not the original`);
      writeFileSync(saved, before + "\n", { mode: 0o600 });
      await swapTrigger(db, true, null);
    } else
      await swapTrigger(db, false, existsSync(saved) ? readFileSync(saved, "utf8").trim() : null);
    const after = await triggerDefinition(db);
    log({ trigger: triggerShape(after), definition: after, setting: guardSetting });
    mirror({
      state: install ? "trigger_guarded" : "trigger_restored",
      trigger: triggerShape(after),
    });
  } finally {
    await session.close();
  }
}

const commands: Record<string, () => Promise<void>> = {
  check,
  load,
  finalize,
  verify,
  "guard-install": () => swap(true),
  "guard-restore": () => swap(false),
};
const command = commands[positionals[0] ?? ""];
if (!command)
  throw new Error(
    `Usage: history-import-finish.ts ${Object.keys(commands).join("|")} --descriptor F --database-url-file F --state-dir D`,
  );
await command();
