import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const image = process.env.POOL_TEST_IMAGE;

function docker(args: string[], input?: string) {
  const result = spawnSync("docker", args, { encoding: "utf8", input, timeout: 60_000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return (args[0] === "logs" ? result.stdout + result.stderr : result.stdout).trim();
}

async function postgresReady(container: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = spawnSync("docker", ["exec", container, "pg_isready", "-U", "fixture_root"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (result.status === 0) return;
    await delay(100);
  }
  throw new Error("The isolated startup database did not become ready");
}

for (const { postgres, databaseImage, pgbouncer } of [
  {
    postgres: "16-alpine",
    databaseImage:
      "postgres:16-alpine@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139",
    pgbouncer: "1.25.2-r0",
  },
  {
    postgres: "17.7-alpine",
    databaseImage:
      "postgres:17.7-alpine@sha256:bb377b7239d2774ac8cc76f481596ce96c5a6b5e9d141f6d0a0ee371a6e7c0f2",
    pgbouncer: "1.25.1-r0",
  },
]) {
  test(
    `Home starts directly and through five-slot transaction pooling on PostgreSQL ${postgres}`,
    {
      skip: !image,
      timeout: 240_000,
    },
    async (t) => {
      const network = `basalt-startup-${randomUUID()}`;
      const containers: string[] = [];
      docker(["network", "create", network]);
      try {
        const database = docker([
          "run",
          "--detach",
          "--network",
          network,
          "--network-alias",
          "database",
          "--env",
          "POSTGRES_USER=fixture_root",
          "--env",
          "POSTGRES_PASSWORD=fixture-only",
          "--env",
          "POSTGRES_DB=postgres",
          databaseImage,
        ]);
        containers.push(database);
        await postgresReady(database);
        docker(["exec", database, "apk", "add", "--no-cache", `pgbouncer=${pgbouncer}`]);
        docker(
          [
            "exec",
            "-i",
            database,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "fixture_root",
            "-d",
            "postgres",
          ],
          `
CREATE ROLE basalt_pool_owner NOLOGIN;
CREATE ROLE budget_a LOGIN PASSWORD 'fixture-only';
CREATE ROLE denied_owner_login LOGIN PASSWORD 'fixture-only';
GRANT basalt_pool_owner TO budget_a WITH INHERIT TRUE, SET TRUE;
CREATE DATABASE standalone OWNER fixture_root;
CREATE DATABASE pooled OWNER basalt_pool_owner;
CREATE DATABASE direct_stable_owner OWNER basalt_pool_owner;
CREATE DATABASE missing_owner OWNER fixture_root;
CREATE DATABASE pooled_missing_owner OWNER basalt_pool_owner;
CREATE DATABASE denied_owner OWNER basalt_pool_owner;
CREATE DATABASE direct_denied_owner OWNER basalt_pool_owner;
`,
        );
        docker(
          ["exec", "-i", database, "sh", "-c", "cat > /tmp/startup-pgbouncer.ini"],
          `
[databases]
* = host=127.0.0.1 port=5432
[pgbouncer]
listen_addr=0.0.0.0
listen_port=6432
auth_type=trust
auth_file=/tmp/startup-users.txt
pool_mode=transaction
default_pool_size=5
max_db_connections=5
max_client_conn=400
max_prepared_statements=200
ignore_startup_parameters=extra_float_digits
server_lifetime=60
server_idle_timeout=15
logfile=/tmp/startup-pgbouncer.log
pidfile=/tmp/startup-pgbouncer.pid
`,
        );
        docker(
          ["exec", "-i", database, "sh", "-c", "cat > /tmp/startup-users.txt"],
          '"budget_a" "fixture-only"\n"denied_owner_login" "fixture-only"\n',
        );
        docker([
          "exec",
          database,
          "chown",
          "postgres",
          "/tmp/startup-pgbouncer.ini",
          "/tmp/startup-users.txt",
        ]);
        docker([
          "exec",
          "--user",
          "postgres",
          database,
          "pgbouncer",
          "-d",
          "/tmp/startup-pgbouncer.ini",
        ]);

        for (const scenario of [
          {
            name: "direct login owner",
            user: "fixture_root",
            port: 5432,
            database: "standalone",
            owner: "",
            ready: true,
          },
          {
            name: "pooled stable owner",
            user: "budget_a",
            port: 6432,
            database: "pooled",
            owner: "basalt_pool_owner",
            ready: true,
          },
          {
            name: "direct stable owner",
            user: "budget_a",
            port: 5432,
            database: "direct_stable_owner",
            owner: "basalt_pool_owner",
            ready: true,
          },
          {
            name: "missing configured owner",
            user: "fixture_root",
            port: 5432,
            database: "missing_owner",
            owner: "missing_fixture_owner",
            ready: false,
          },
          {
            name: "pooled missing configured owner",
            user: "budget_a",
            port: 6432,
            database: "pooled_missing_owner",
            owner: "missing_fixture_owner",
            ready: false,
          },
          {
            name: "denied configured owner",
            user: "denied_owner_login",
            port: 6432,
            database: "denied_owner",
            owner: "basalt_pool_owner",
            ready: false,
          },
          {
            name: "direct denied configured owner",
            user: "denied_owner_login",
            port: 5432,
            database: "direct_denied_owner",
            owner: "basalt_pool_owner",
            ready: false,
          },
        ]) {
          await t.test(scenario.name, async () => {
            const container = docker([
              "run",
              "--detach",
              "--network",
              network,
              "--publish",
              "127.0.0.1::8318",
              "--env",
              `POOL_DATABASE_URL=postgresql://${scenario.user}:fixture-only@database:${scenario.port}/${scenario.database}?sslmode=disable`,
              "--env",
              "POOL_MANAGEMENT_KEY=fixture-management-key",
              "--env",
              "POOL_APP_SIGNING_KEY=" + "ab".repeat(32),
              ...(scenario.owner ? ["--env", `POOL_DATABASE_SCHEMA_OWNER=${scenario.owner}`] : []),
              image!,
            ]);
            containers.push(container);
            try {
              const address = docker(["port", container, "8318/tcp"]);
              const deadline = Date.now() + 90_000;
              let ready = false;
              let running = true;
              while (Date.now() < deadline) {
                running =
                  docker(["inspect", container, "--format", "{{.State.Running}}"]) === "true";
                if (!running) break;
                try {
                  const response = await fetch(`http://${address}/ready`, {
                    headers: { Authorization: "Bearer fixture-management-key" },
                    signal: AbortSignal.timeout(2_000),
                  });
                  ready = response.ok;
                  await response.body?.cancel();
                  if (ready) break;
                } catch {
                  /* The supervisor has not opened its readiness port yet. */
                }
                await delay(100);
              }
              const logs = docker(["logs", container]);
              assert.equal(ready, scenario.ready, logs);
              if (!scenario.ready) {
                assert.equal(running, false, "A schema-owner failure must end startup");
                assert.notEqual(
                  docker(["inspect", container, "--format", "{{.State.ExitCode}}"]),
                  "0",
                );
                assert.equal(docker(["inspect", container, "--format", "{{.RestartCount}}"]), "0");
                assert.equal(logs.match(/POOL_HOME_SCHEMA_OWNER_UNAVAILABLE/g)?.length, 1, logs);
                assert.equal(logs.match(/"phase":"home_boot"/g)?.length, 1, logs);
              }
            } finally {
              docker(["rm", "--force", container]);
              containers.splice(containers.indexOf(container), 1);
            }
          });
        }
      } finally {
        for (const container of containers.reverse()) docker(["rm", "--force", container]);
        docker(["network", "rm", network]);
      }
    },
  );
}
