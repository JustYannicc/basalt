import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import pg from "pg";
import { poolDatabase } from "../../src/pool/database-settings.ts";
import { managedMigrationUrl } from "./managed-postgres.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname)) {
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");
}

const startupPhaseNames = ["home_boot", "bootstrap_import", "config_apply", "node_launch", "initial_health"] as const;
const maxStartupPhaseMs = 86_400_000;

function docker(args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function until<T>(probe: () => Promise<T | undefined>, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The pool did not satisfy its readiness contract within the test budget");
}

async function waitForStartupPhaseLogs(containerId: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const logs = docker(["logs", containerId]);
    const hasInitialHealth = logs.split(/\r?\n/).some(
      (line) => line.startsWith("POOL_STARTUP_PHASE ") && line.includes('"phase":"initial_health"'),
    );
    if (hasInitialHealth) return logs;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Startup phase records did not reach container logs after readiness");
}

function assertStartupPhaseLogs(logs: string): void {
  const prefix = "POOL_STARTUP_PHASE ";
  const lines = logs.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  const phases: string[] = [];
  const fields = ["phase", "start_ms", "end_ms", "duration_ms"];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(prefix.length));
    } catch {
      assert.fail("startup phase record was not valid JSON");
    }
    assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), "startup phase record was not an object");
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    assert.ok(keys.length === fields.length && fields.every((field) => Object.hasOwn(record, field)), "startup phase schema changed");

    const phase = record.phase;
    assert.ok(typeof phase === "string" && (startupPhaseNames as readonly string[]).includes(phase), "startup phase name was outside the closed enum");
    const measurements = [record.start_ms, record.end_ms, record.duration_ms];
    assert.ok(measurements.every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maxStartupPhaseMs),
      "startup phase measurements were outside the integer bound");
    const startMs = record.start_ms as number;
    const endMs = record.end_ms as number;
    const durationMs = record.duration_ms as number;
    assert.ok(endMs >= startMs && durationMs === endMs - startMs, "startup phase duration did not match its monotonic offsets");
    phases.push(phase);
  }

  const withoutBootstrap = ["home_boot", "config_apply", "node_launch", "initial_health"];
  const withBootstrap = ["home_boot", "bootstrap_import", "home_boot", "config_apply", "node_launch", "initial_health"];
  assert.ok(phases.join(",") === withoutBootstrap.join(",") || phases.join(",") === withBootstrap.join(","),
    "real image startup phases were missing or out of order");
}

test("pinned Home/node stream, stick, spread, fail over at quota and retain keys after restart", { timeout: 240_000 }, async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let containerId: string | undefined;
  let quotaKey: string | undefined;
  const calls: string[] = [];
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the request before returning the fixture stream. */ }
    const key = request.headers.authorization ?? "";
    calls.push(key);
    if (key === quotaKey) {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      response.end(JSON.stringify({ error: { message: "fixture quota", type: "rate_limit_error", code: "rate_limit_exceeded" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "0.0.0.0", resolve));
  try {
    const migrationUrl = await managedMigrationUrl(admin, adminUrl!);
    await admin.query("CREATE ROLE pool_container_test LOGIN PASSWORD 'fixture-only'");
    const provision = spawnSync(process.execPath, ["scripts/ensure-pool-database.ts"], {
      env: { ...process.env, POOL_DATABASE_ADMIN_URL: migrationUrl, POOL_DATABASE_RUNTIME_ROLE: "pool_container_test" },
      encoding: "utf8",
    });
    assert.equal(provision.status, 0, provision.stderr);
    const databaseUrl = new URL(adminUrl!);
    databaseUrl.hostname = "host.docker.internal";
    databaseUrl.username = "pool_container_test";
    databaseUrl.password = "fixture-only";
    databaseUrl.pathname = `/${poolDatabase.name}`;
    databaseUrl.searchParams.set("options", `-c role=${poolDatabase.owner}`);
    const hostMapping = process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : [];
    containerId = docker([
      "run", "--detach", "--name", `basalt-1409-pool-test-${process.pid}`,
      "--memory", "256m", ...hostMapping,
      "--publish", "127.0.0.1::8317", "--publish", "127.0.0.1::8318", "--publish", "127.0.0.1::8327",
      "--env", `POOL_DATABASE_URL=${databaseUrl}`,
      "--env", "POOL_MANAGEMENT_KEY=fixture-management-key",
      "--env", "POOL_MANAGEMENT_ALLOW_REMOTE=true",
      process.env.POOL_TEST_IMAGE ?? "basalt-1409-pool:test",
    ]);
    function origin(port: number): string {
      const mapping = docker(["port", containerId!, String(port)]);
      assert.match(mapping, /^127\.0\.0\.1:\d+$/);
      return `http://${mapping}`;
    }
    let home = origin(8327);
    let node = origin(8317);
    let readiness = origin(8318);
    const managementHeaders = { "Content-Type": "application/json", "X-Management-Key": "fixture-management-key" };
    async function ready() {
      return until(async () => {
        const response = await fetch(`${readiness}/ready`, {
          headers: { Authorization: "Bearer fixture-management-key" }, signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) return;
        const status = await response.json() as { boot_id: string; started_at: string };
        assert.deepEqual(Object.keys(status).sort(), ["boot_id", "started_at"]);
        return status;
      });
    }
    const initial = await ready();
    const startupLogs = await waitForStartupPhaseLogs(containerId);
    assertStartupPhaseLogs(startupLogs);
    assert.equal((await fetch(`${node}/v1/models`)).status, 401);
    assert.equal((await fetch(`${home}/v8/management/config`)).status, 401);
    assert.equal((await fetch(`${readiness}/ready`)).status, 401);
    const address = upstream.address();
    assert.ok(address && typeof address !== "string");
    const patch = await fetch(`${home}/v8/management/config`, {
      method: "PATCH", headers: managementHeaders,
      body: JSON.stringify({
        access: { "api-keys": ["fixture-client-key"] },
        "api-keys": { "openai-compatibility": [{
          name: "fixture", "base-url": `http://host.docker.internal:${address.port}/v1`,
          keys: [{ "api-key": "fixture-a" }, { "api-key": "fixture-b" }],
          models: [{ name: "fixture-model", alias: "fixture-model" }],
        }] },
      }),
    });
    assert.equal(patch.status, 200);
    async function catalog() {
      const response = await fetch(`${node}/v1/models`, { headers: { Authorization: "Bearer fixture-client-key" } });
      const payload = await response.json() as { data?: { id: string }[] };
      return response.ok && payload.data?.some((model) => model.id === "fixture-model") ? true : undefined;
    }
    await until(catalog);
    const richCatalog = await fetch(`${node}/v1/models?client_version=cpa`, { headers: { Authorization: "Bearer fixture-client-key" } });
    assert.equal(richCatalog.status, 200);
    const rich = await richCatalog.json() as { models: { slug: string; service_tiers: unknown[] }[] };
    assert.deepEqual(rich.models.map((model) => model.slug), ["fixture-model"]);
    async function turn(session: string) {
      const before = calls.length;
      const response = await fetch(`${node}/v1/chat/completions`, {
        method: "POST", headers: {
          Authorization: "Bearer fixture-client-key", "Content-Type": "application/json", "X-Claude-Code-Session-Id": session,
        },
        body: JSON.stringify({ model: "fixture-model", stream: true, max_tokens: 16, prompt_cache_key: session, messages: [{ role: "user", content: "Reply OK" }] }),
        signal: AbortSignal.timeout(45_000),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /data: \[DONE\]/);
      return calls.slice(before);
    }
    const first = await turn("fixture-conversation-a");
    const second = await turn("fixture-conversation-b");
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    assert.notEqual(first[0], second[0]);
    assert.deepEqual(await turn("fixture-conversation-a"), first);
    assert.deepEqual(await turn("fixture-conversation-b"), second);
    quotaKey = first[0];
    const failover = await turn("fixture-conversation-a");
    assert.deepEqual(failover, [first[0], second[0]]);
    docker(["restart", "--time", "20", containerId]);
    // Docker may assign new random host ports when the container restarts.
    home = origin(8327);
    node = origin(8317);
    readiness = origin(8318);
    const restarted = await ready();
    assert.notEqual(restarted.boot_id, initial.boot_id);
    await until(catalog);
    // The boot patch must preserve the existing client key and provider credentials.
    assert.ok((await turn("fixture-conversation-after-restart")).length > 0);
  } catch (error) {
    if (containerId) {
      const logs = spawnSync("docker", ["logs", "--tail", "30", containerId], { encoding: "utf8" });
      console.error(logs.stdout, logs.stderr);
    }
    throw error;
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (containerId) docker(["rm", "--force", containerId]);
    await admin.query(`DROP DATABASE IF EXISTS ${poolDatabase.name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${poolDatabase.owner}`);
    await admin.query("DROP ROLE IF EXISTS pool_container_test");
    await admin.end();
  }
});
