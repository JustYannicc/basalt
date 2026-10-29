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
