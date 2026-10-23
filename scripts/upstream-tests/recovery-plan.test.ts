import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const scratch = join(repo, ".t3/1407/state-bootstrap-research");

test("empty-state Alchemy plan adopts basalt and schedules both PlanetScale role creates", async () => {
  mkdirSync(scratch, { recursive: true });
  const calls: Array<{ method: string; path: string }> = [];
  const database = {
    id: "db-basalt-fixture",
    url: "/organizations/fixture/databases/basalt",
    branches_url: "/organizations/fixture/databases/basalt/branches",
    ready: true,
    region: {
      id: "region-eu-central",
      provider: "AWS",
      enabled: true,
      public_ip_addresses: [],
      display_name: "EU Central",
      location: "Frankfurt",
      slug: "eu-central",
      current_default: false,
      mysql_supported: true,
      postgresql_supported: true,
      neki_supported: false,
    },
    html_url: "https://fixture.invalid/basalt",
    name: "basalt",
    state: "ready",
    default_branch: "main",
    require_approval_for_deploy: false,
    restrict_branch_region: false,
    plan: "hobby",
    production_branch_web_console: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    kind: "postgresql",
  };
  const branch = {
    id: "branch-basalt-main-fixture",
    name: "main",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    deleted_at: null,
    restore_checklist_completed_at: null,
    schema_last_updated_at: null,
    kind: "postgresql",
    state: "ready",
    cluster_name: "PS_5",
    cluster_iops: null,
    ready: true,
    metal: false,
    production: true,
    safe_migrations: true,
    stale_schema: false,
    actor: null,
    restored_from_branch: null,
    private_edge_connectivity: false,
    has_replicas: false,
    has_read_only_replicas: false,
    html_url: "https://fixture.invalid/basalt/main",
    url: "/organizations/fixture/databases/basalt/branches/main",
    region: database.region,
    parent_branch: null,
    cluster_architecture: "aarch64",
  };

  const api = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    calls.push({ method: request.method ?? "", path });
    response.setHeader("content-type", "application/json");
    if (
      request.method === "GET" &&
      /\/organizations\/fixture\/databases\/basalt$/.test(path)
    ) {
      response.end(JSON.stringify(database));
    } else if (
      request.method === "GET" &&
      /\/organizations\/fixture\/databases\/basalt\/branches\/main$/.test(path)
    ) {
      response.end(JSON.stringify(branch));
    } else {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "unexpected fixture API request" }));
    }
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");

  const directory = mkdtempSync(join(scratch, "plan-"));
  try {
    symlinkSync(join(repo, "node_modules"), join(directory, "node_modules"), "dir");
    const entrypoint = join(directory, "recovery-stack.ts");
    writeFileSync(
      entrypoint,
      `import * as Alchemy from "alchemy";
import * as Planetscale from "alchemy/Planetscale";
import { adopt } from "alchemy/AdoptPolicy";
import { retain } from "alchemy/RemovalPolicy";
import { Config, Effect } from "effect";

export default Alchemy.Stack(
  "basalt",
  { providers: Planetscale.providers(), state: Alchemy.inMemoryState() },
  Effect.gen(function* () {
    const settings = yield* Config.all({
      name: Config.String("PLANETSCALE_DATABASE_NAME"),
      clusterSize: Config.String("PLANETSCALE_CLUSTER_SIZE"),
      region: Config.String("PLANETSCALE_REGION"),
      adopt: Config.Boolean("PLANETSCALE_ADOPT_DATABASE").pipe(
        Config.withDefault(false),
      ),
    });
    const database = yield* Planetscale.PostgresDatabase("Database", {
      name: settings.name,
      clusterSize: settings.clusterSize,
      region: { slug: settings.region },
    }).pipe(adopt(settings.adopt), retain());
    yield* Planetscale.PostgresRole("RuntimeRole", {
      database,
      inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
    });
    yield* Planetscale.PostgresRole("MigrationRole", {
      database,
      inheritedRoles: ["postgres"],
    }).pipe(retain());
    return {};
  }).pipe(adopt(true)),
);
`,
    );
    const address = api.address();
    assert.ok(address && typeof address === "object");
    const result = await new Promise<{
      status: number | null;
      error?: Error;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn(
        "bun",
        [
          "run",
          "alchemy",
          "plan",
          "--stage",
          "production",
          "--no-input",
          entrypoint,
        ],
        {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            CI: "true",
            ALCHEMY_STAGE: "production",
            PLANETSCALE_ORGANIZATION: "fixture",
            PLANETSCALE_API_TOKEN_ID: "fixture-id",
            PLANETSCALE_API_TOKEN: "fixture-token",
            PLANETSCALE_API_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            PLANETSCALE_DATABASE_NAME: "basalt",
            PLANETSCALE_CLUSTER_SIZE: "PS_5",
            PLANETSCALE_REGION: "eu-central",
            PLANETSCALE_ADOPT_DATABASE: "true",
          },
        },
      );
      let stdout = "";
      let stderr = "";
      let error: Error | undefined;
      const timeout = setTimeout(() => {
        error = new Error("plan process exceeded 25 seconds");
        child.kill("SIGKILL");
      }, 25_000);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (cause) => {
        error = cause;
      });
      child.on("close", (status) => {
        clearTimeout(timeout);
        resolve({ status, error, stdout, stderr });
      });
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.error, undefined, output);
    assert.equal(result.status, 0, output);
    assert.match(output, /Plan: 2 to create, 1 to adopted/);
    assert.match(output, /\[Database\] adopted/);
    assert.match(output, /\[RuntimeRole\] create/);
    assert.match(output, /\[MigrationRole\] create/);
    assert.ok(
      calls.some(
        ({ method, path }) =>
          method === "GET" && path.endsWith("/databases/basalt"),
      ),
      JSON.stringify(calls),
    );
    assert.ok(
      calls.some(
        ({ method, path }) =>
          method === "GET" && path.endsWith("/branches/main"),
      ),
      JSON.stringify(calls),
    );
    assert.ok(calls.every(({ method }) => method === "GET"), JSON.stringify(calls));
    assert.equal(calls.length, 2, JSON.stringify(calls));
  } finally {
    const closed = once(api, "close");
    api.close();
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
});
