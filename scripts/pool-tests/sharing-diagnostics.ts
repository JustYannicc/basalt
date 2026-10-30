import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function output(args: string[], input?: string): string {
  const result = spawnSync("docker", args, { input, encoding: "utf8", timeout: 30_000 });
  // Driver text can contain the very diagnostic content this test is checking.
  const state = /(?:ERROR|FATAL):\s+([0-9A-Z]{5})\b/.exec(result.stderr ?? "")?.[1] ?? "unavailable";
  assert.equal(result.status, 0, `Disposable diagnostic inspection failed (SQLSTATE ${state})`);
  return result.stdout;
}
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Scans raw sinks before any fixture redaction, returning counts only. */
export class FixtureDiagnostics {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  sql(query: string): string {
    return output(["exec", "-i", `${this.name}-postgres`, "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "-v", "VERBOSITY=sqlstate", "-U", "fixture_admin", "-d", "basalt_pool", "-At"], query).trim();
  }

  failureHealth(): Record<string, number> {
    const read = (args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 5_000 });
    const health: Record<string, number> = {
      postgres_running: -1, postgres_oom_killed: -1, postgres_exit_code: -1, postgres_restarts: -1,
      data_used_kib: -1, data_available_kib: -1,
    };
    const inspected = read(["inspect", `${this.name}-postgres`]);
    try {
      const container = JSON.parse(inspected.stdout)[0];
      if (typeof container.State?.Running === "boolean") health.postgres_running = Number(container.State.Running);
      if (typeof container.State?.OOMKilled === "boolean") health.postgres_oom_killed = Number(container.State.OOMKilled);
      if (Number.isSafeInteger(container.State?.ExitCode)) health.postgres_exit_code = container.State.ExitCode;
      if (Number.isSafeInteger(container.RestartCount)) health.postgres_restarts = container.RestartCount;
    } catch { /* Missing container state stays unknown. */ }
    const disk = read(["exec", `${this.name}-postgres`, "df", "-Pk", "/var/lib/postgresql/data"]);
    const columns = (disk.stdout ?? "").trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
    if (disk.status === 0 && /^\d+$/.test(columns[2] ?? "") && /^\d+$/.test(columns[3] ?? "")) {
      health.data_used_kib = Number(columns[2]);
      health.data_available_kib = Number(columns[3]);
    }
    // Project fixed signatures only. Raw Postgres logs can contain row values.
    const logs = read(["logs", "--tail", "200", `${this.name}-postgres`]);
    const raw = `${logs.stdout ?? ""}${logs.stderr ?? ""}`;
    for (const [name, pattern] of Object.entries({
      no_space: /No space left on device/g,
      signal_9: /terminated by signal 9/g,
      out_of_memory: /out of memory/gi,
      panic: /PANIC:/g,
      recovery: /database system is in recovery mode/g,
      shutdown: /database system is shut down/g,
    })) health[`postgres_log_${name}`] = (raw.match(pattern) ?? []).length;
    return health;
  }

  statementTimesOut(query: string, role = "fixture_admin"): boolean {
    const result = spawnSync("docker", ["exec", "-i", `${this.name}-postgres`, "psql", "-X", "-v", "ON_ERROR_STOP=1",
      "-v", "VERBOSITY=sqlstate", "-U", "fixture_admin", "-d", "basalt_pool", "-At"], {
      input: `begin; set local role ${identifier(role)}; set local statement_timeout='30s'; set local application_name='home-privacy-maintenance'; ${query}`,
      encoding: "utf8", timeout: 40_000,
    });
    return result.status === 3 && /57014/.test(result.stderr);
  }

  async waitForPrivacy(timeout = 90_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.sql("select count(*) from home_data_migration where completed=false or audit_marker_emitted=false") === "0" &&
        this.sql("select count(*) from home_data_migration") !== "0") return;
      await delay(200);
    }
    assert.fail("Privacy cleanup did not complete within the fixture budget");
  }

  async waitForAppLogPrivacy(timeout = 90_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.sql("select count(*) from home_data_migration where app_logs_done=false or app_log_audit_marker_emitted=false") === "0" &&
        this.sql("select count(*) from home_data_migration") !== "0") return;
      await delay(200);
    }
    assert.fail("App-log cleanup did not complete within the fixture budget");
  }

  pushAppLog(payload: { line: string; level: string; timestamp: string; request_id: string }): void {
    // Use the running node's synthetic mTLS identity over Home's real RESP path.
    // Certificate bytes stay inside the disposable container.
    const script = `import json,pathlib,socket,ssl,sys
certificates=list(pathlib.Path('/dev/shm/cliproxy-pool/node').glob('*/.cli-proxy-api/client-crt.pem'))
assert len(certificates)==1, 'expected one synthetic node identity'
directory=certificates[0].parent
context=ssl.create_default_context(cafile=str(directory/'home-ca-crt.pem'))
context.load_cert_chain(str(directory/'client-crt.pem'),str(directory/'client-key.pem'))
parts=[b'RPUSH',b'app-log',sys.argv[1].encode()]
command=b'*3\\r\\n'+b''.join(b'$'+str(len(part)).encode()+b'\\r\\n'+part+b'\\r\\n' for part in parts)
with socket.create_connection(('127.0.0.1',8327),timeout=5) as plain:
 with context.wrap_socket(plain,server_hostname='127.0.0.1') as connection:
  connection.sendall(command)
  reply=connection.makefile('rb').readline()
  assert reply==b':1\\r\\n', 'synthetic app-log push was rejected'
print('1')
`;
    assert.equal(output(["exec", `${this.name}-pool`, "python3", "-c", script, JSON.stringify(payload)]).trim(), "1");
  }

  async scan(secrets: readonly string[]): Promise<{ database: number; files: number; logs: number }> {
    assert.ok(secrets.length && secrets.every((value) => value.length >= 8));
    const tables = this.sql("select tablename from pg_tables where schemaname='public' and " +
      "(tablename ~* '(usage|request|log|history|audit|event|diagnostic)' or tablename='billing_charge')").split("\n").filter(Boolean);
    assert.ok(tables.includes("usage"));
    let database = 0;
    for (const table of tables) {
      const where = secrets.map((secret) => `strpos(row_to_json(t)::text, ${literal(secret)}) > 0`).join(" OR ");
      database += Number(this.sql(`select count(*) from ${identifier(table)} t where ${where}`));
    }
    const script = `import json,pathlib,sys
secrets=[s.encode() for s in json.loads(sys.argv[1])]
hits=0
for p in pathlib.Path('/dev/shm/cliproxy-pool').rglob('*'):
 if not p.is_file(): continue
 name=p.name.lower()
 if not (name.endswith('.log') or name.startswith(('request-log-parts-', 'error-', 'request-'))): continue
 if p.stat().st_size > 67108864: raise RuntimeError('unbounded diagnostic file')
 data=p.read_bytes()
 hits += any(s in data for s in secrets)
print(hits)
`;
    const files = Number(output(["exec", `${this.name}-pool`, "python3", "-c", script, JSON.stringify(secrets)]).trim());
    let logs = 0;
    for (const name of [`${this.name}-pool`, `${this.name}-postgres`]) {
      const result = spawnSync("docker", ["logs", name], { encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, "Disposable raw log inspection failed");
      const raw = `${result.stdout}${result.stderr}`;
      logs += secrets.filter((secret) => raw.includes(secret)).length;
    }
    assert.ok([database, files, logs].every(Number.isSafeInteger));
    return { database, files, logs };
  }
}
