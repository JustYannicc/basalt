import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Redacted } from "effect";
import type { withPoolRegistryPull } from "../deploy-safety/pool-image-metadata.ts";
import {
  HomeContainerCleanupError,
  withCandidateHome,
  type HomeContainerCommand,
} from "./home-schema-container.ts";
import { HomeSchemaCommandError } from "./home-schema-operation.ts";

const digest = `sha256:${"a".repeat(64)}`;
const configDigest = `sha256:${"b".repeat(64)}`;
const image = {
  image: `registry.cloudflare.com/fixture/pool@${digest}`,
  imageDigest: digest,
  imageConfigDigest: configDigest,
};
const databaseUrl = "postgresql://fixture:synthetic-db-secret@fixture.invalid/db?sslmode=require";
const info = { format_version: 1, target_version: 16, required_indexes: ["idx_fixture"] };
const ready = {
  format_version: 1,
  target_version: 16,
  previous_version: null,
  applied_version: 16,
  status: "ready",
  indexes_checked: true,
  pending_indexes: [],
};
const pending = {
  ...ready,
  applied_version: 15,
  status: "pending",
  indexes_checked: false,
  reason: "schema_pending",
};
const migrated = { ...ready, previous_version: 15, status: "migrated" };
const registry: typeof withPoolRegistryPull = async (ref, expected, credentials, consume) => {
  assert.equal(ref, image.image);
  assert.equal(expected, digest);
  assert.equal(credentials.accountId, "fixture");
  return consume({
    username: "fixture",
    password: "synthetic-pull-secret",
    repository: "fixture/pool",
  });
};
type Call = { args: string[]; options: Parameters<HomeContainerCommand>[1] };
function fixture(
  options: {
    config?: string;
    createFailure?: "timeout" | "nonzero";
    startFailure?: "timeout" | "lost-reply";
    removeFailure?: boolean | "migration";
    response?: { code: number; stdout: string };
  } = {},
) {
  const calls: Call[] = [];
  const containers = new Map<string, string>();
  let directory = "";
  let bootstrap = "";
  const execute: HomeContainerCommand = async (args, settings) => {
    calls.push({ args, options: settings });
    directory = args[1];
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, "config.json")).mode & 0o777, 0o600);
    const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
    assert.equal(
      config.auths["registry.cloudflare.com"].auth,
      Buffer.from("fixture:synthetic-pull-secret").toString("base64"),
    );
    assert.ok(!args.join(" ").includes("synthetic-db-secret"));
    assert.ok(!args.join(" ").includes("synthetic-pull-secret"));
    const operation = args[2];
    if (operation === "pull") {
      assert.equal(settings.capture, false);
      return { code: 0, stdout: "discarded pull diagnostics" };
    }
    if (operation === "image") return { code: 0, stdout: options.config ?? configDigest };
    if (operation === "create") {
      const mode = args.at(-1)!;
      const id = String(containers.size + 1).padStart(64, "0");
      containers.set(id, mode);
      const cidPath = args[args.indexOf("--cidfile") + 1];
      assert.equal(existsSync(cidPath), false);
      writeFileSync(cidPath, `${id}\n`);
      if (mode !== "-db-schema-info") bootstrap = args[args.indexOf("-c") + 1];
      if (options.createFailure && mode !== "-db-schema-info") {
        if (options.createFailure === "timeout")
          throw new HomeSchemaCommandError("command-timeout");
        return { code: 1, stdout: "raw create diagnostic" };
      }
      return { code: 0, stdout: "untrusted create output, CID file is authoritative" };
    }
    if (operation === "start") {
      const mode = containers.get(args.at(-1)!);
      if (mode === "-db-schema-info") {
        assert.equal(settings.input, undefined);
        return { code: 0, stdout: JSON.stringify(info) };
      }
      assert.deepEqual(JSON.parse(settings.input!), {
        database_url: databaseUrl,
        schema_owner: "basalt_pool_owner",
      });
      assert.ok(settings.timeoutMs > 600_000 && settings.timeoutMs <= 645_000);
      if (options.startFailure === "timeout") throw new HomeSchemaCommandError("command-timeout");
      if (options.startFailure === "lost-reply")
        throw new Error(`raw child diagnostic ${databaseUrl}`);
      return (
        options.response ?? {
          code: 0,
          stdout: JSON.stringify(mode === "-db-migrate" ? migrated : ready),
        }
      );
    }
    assert.equal(operation, "rm");
    assert.equal(args[3], "--force");
    assert.ok(containers.has(args.at(-1)!));
    assert.equal(settings.timeoutMs, 15_000);
    assert.equal(settings.capture, false);
    const refused =
      options.removeFailure === true ||
      (options.removeFailure === "migration" && containers.get(args.at(-1)!) === "-db-migrate");
    return { code: refused ? 1 : 0, stdout: "discarded removal diagnostic" };
  };
  return {
    calls,
    containers,
    execute,
    registry,
    get directory() {
      return directory;
    },
    get bootstrap() {
      return bootstrap;
    },
  };
}
function run<T>(
  f: ReturnType<typeof fixture>,
  work: Parameters<typeof withCandidateHome<T>>[0]["work"],
) {
  return withCandidateHome({
    image,
    credentials: { accountId: "fixture", apiToken: "synthetic-api-token" },
    databaseUrl: Redacted.make(databaseUrl),
    execute: f.execute,
    registry: f.registry,
    work,
  });
}
const operations = (f: ReturnType<typeof fixture>, operation: string) =>
  f.calls.filter((call) => call.args[2] === operation);

test("immutable image and config mismatches stop before native execution", async () => {
  const f = fixture({ config: `sha256:${"c".repeat(64)}` });
  await assert.rejects(
    run(f, async () => assert.fail("must not run")),
    /image-mismatch/,
  );
  assert.equal(operations(f, "create").length, 0);
  assert.equal(existsSync(f.directory), false);
  for (const invalid of [
    { ...image, image: "registry.cloudflare.com/fixture/pool:latest" },
    { ...image, imageDigest: configDigest },
    { ...image, imageConfigDigest: "mutable" },
  ]) {
    await assert.rejects(
      withCandidateHome({
        image: invalid,
        credentials: { accountId: "fixture", apiToken: "fixture" },
        databaseUrl: Redacted.make(databaseUrl),
        execute: f.execute,
        registry,
        work: async () => assert.fail("must not run"),
      }),
      /image-mismatch/,
    );
  }
  assert.equal(f.calls.length, 2);
});

test("info has no database input; checks reuse no CID files and bypass supervisor, healthchecks and ports", async () => {
  const f = fixture();
  await run(f, async (commands) => {
    assert.deepEqual(commands.info, info);
    await commands.check();
    await commands.check();
  });
  const creates = operations(f, "create");
  assert.equal(creates.length, 3);
  const infoArgs = creates[0].args;
  assert.equal(infoArgs[infoArgs.indexOf("--entrypoint") + 1], "/usr/local/bin/cliproxy-home");
  assert.deepEqual(infoArgs.slice(-2), [image.image, "-db-schema-info"]);
  assert.equal(infoArgs[infoArgs.indexOf("--network") + 1], "none");
  const paths = creates.map(({ args }) => args[args.indexOf("--cidfile") + 1]);
  assert.equal(new Set(paths).size, 3);
  for (const { args } of creates) {
    assert.ok(args.includes("--no-healthcheck"));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("/dev/shm:rw,noexec,nosuid,nodev,mode=1777,size=16m"));
    assert.ok(!args.some((arg) => ["--publish", "-p", "--env", "-e", "--env-file"].includes(arg)));
    assert.ok(!args.join(" ").includes("pool.supervisor"));
  }
  assert.equal(operations(f, "rm").length, 3);
  assert.ok(paths.every((path) => !existsSync(path)));
  assert.equal(existsSync(f.directory), false);
});

test("pending check and migrated replies retain native metadata", async () => {
  const check = fixture({ response: { code: 1, stdout: JSON.stringify(pending) } });
  await run(check, async (commands) => assert.deepEqual(await commands.check(), pending));
  const migration = fixture();
  await run(migration, async (commands) => assert.deepEqual(await commands.migrate(), migrated));
});

test("migration allocation is persisted before start and the wrapper never repeats a write", async () => {
  const f = fixture();
  await run(f, async (commands) => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const allocated = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const migration = commands.migrate(async (id) => {
      assert.equal(f.containers.get(id), "-db-migrate");
      entered();
      await held;
    });
    await allocated;
    assert.equal(operations(f, "start").length, 1);
    release();
    await migration;
    await assert.rejects(commands.migrate(), /command-failed/);
  });
  assert.equal([...f.containers.values()].filter((mode) => mode === "-db-migrate").length, 1);
});

test("callback refusal prevents native start and cleans its exact allocated container", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, async (commands) =>
      commands.migrate(async () => {
        throw new Error("record refused");
      }),
    ),
    /record refused/,
  );
  assert.equal(operations(f, "start").length, 1);
  assert.deepEqual(
    operations(f, "rm").map((call) => call.args.at(-1)),
    [...f.containers.keys()],
  );
  assert.equal(existsSync(f.directory), false);
});

test("timeouts and lost replies remove only captured CIDs and cannot trigger duplicate writes", async () => {
  for (const startFailure of ["timeout", "lost-reply"] as const) {
    const f = fixture({ startFailure });
    await run(f, async (commands) => {
      let id = "";
      await assert.rejects(
        commands.migrate(async (allocated) => {
          id = allocated;
        }),
        (error: unknown) => {
          assert.ok(error instanceof HomeSchemaCommandError);
          assert.equal(
            error.message,
            startFailure === "timeout" ? "command-timeout" : "command-failed",
          );
          assert.ok(!String(error).includes("synthetic-db-secret"));
          return true;
        },
      );
      assert.equal(operations(f, "rm").at(-1)?.args.at(-1), id);
      await assert.rejects(commands.migrate(), /command-failed/);
    });
    assert.equal(operations(f, "start").length, 2);
    assert.equal(existsSync(f.directory), false);
  }
  for (const createFailure of ["timeout", "nonzero"] as const) {
    const f = fixture({ createFailure });
    await assert.rejects(
      run(f, (commands) => commands.check()),
      /command-timeout|command-failed/,
    );
    assert.equal(operations(f, "start").length, 1);
    assert.deepEqual(
      operations(f, "rm").map((call) => call.args.at(-1)),
      [...f.containers.keys()],
    );
    assert.equal(existsSync(f.directory), false);
  }
});

test("cleanup failure retains the exact CID and deletes ephemeral registry credentials", async () => {
  const f = fixture({ removeFailure: true });
  await assert.rejects(
    run(f, async () => assert.fail("must not run")),
    (error: unknown) => {
      assert.ok(error instanceof HomeContainerCleanupError);
      assert.equal(error.reason, "cleanup-failed");
      assert.equal(error.containerId, [...f.containers.keys()][0]);
      assert.equal(error.message, "cleanup-failed");
      return true;
    },
  );
  assert.equal(existsSync(f.directory), false);
});

test("lost migration reply with failed cleanup retains the persisted migration CID", async () => {
  const f = fixture({ startFailure: "lost-reply", removeFailure: "migration" });
  let persistedId = "";
  await assert.rejects(
    run(f, (commands) =>
      commands.migrate(async (id) => {
        persistedId = id;
      }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof HomeContainerCleanupError);
      assert.equal(error.containerId, persistedId);
      assert.equal(error.reason, "cleanup-failed");
      assert.ok(!String(error).includes("synthetic-db-secret"));
      return true;
    },
  );
  assert.equal(operations(f, "start").length, 2);
  assert.equal(operations(f, "rm").at(-1)?.args.at(-1), persistedId);
  assert.equal(existsSync(f.directory), false);
});

test("native receipts reject wrong modes, exit codes, versions, indexes and diagnostic output", async () => {
  const invalid = [
    { code: 0, stdout: JSON.stringify(migrated) },
    { code: 0, stdout: JSON.stringify({ ...ready, target_version: 17 }) },
    { code: 0, stdout: JSON.stringify({ ...ready, applied_version: 15 }) },
    { code: 0, stdout: JSON.stringify({ ...ready, indexes_checked: false }) },
    { code: 0, stdout: JSON.stringify({ ...ready, pending_indexes: ["idx_fixture"] }) },
    { code: 0, stdout: JSON.stringify({ ...ready, reason: "schema_pending" }) },
    { code: 1, stdout: JSON.stringify(ready) },
    { code: 137, stdout: JSON.stringify(pending) },
    { code: 1, stdout: JSON.stringify({ ...pending, pending_indexes: ["idx_unknown"] }) },
    { code: 1, stdout: JSON.stringify({ ...pending, previous_version: 15 }) },
    { code: 1, stdout: JSON.stringify({ ...pending, indexes_checked: true }) },
    { code: 1, stdout: JSON.stringify({ ...pending, applied_version: 16 }) },
    {
      code: 1,
      stdout: JSON.stringify({
        ...pending,
        indexes_checked: true,
        pending_indexes: ["idx_fixture", "idx_fixture"],
      }),
    },
    { code: 1, stdout: JSON.stringify({ ...pending, reason: undefined }) },
    { code: 0, stdout: `native diagnostic ${databaseUrl}\n${JSON.stringify(ready)}` },
    { code: 0, stdout: JSON.stringify({ ...ready, diagnostic: databaseUrl }) },
    { code: 0, stdout: " ".repeat(32_769) + JSON.stringify(ready) },
  ];
  for (const response of invalid) {
    const f = fixture({ response });
    await assert.rejects(
      run(f, (commands) => commands.check()),
      /^Error: invalid-receipt$/,
    );
    assert.equal(existsSync(f.directory), false);
  }
});

test("Python bootstrap imports the image package and writes native cluster.yaml before exec", async () => {
  const f = fixture();
  await run(f, (commands) => commands.check());
  assert.ok(!f.bootstrap.includes("-config"));
  assert.ok(f.bootstrap.includes('root=pathlib.Path("/dev/shm/basalt-schema")'));
  const directory = mkdtempSync(join(tmpdir(), "home-bootstrap-fixture-"));
  try {
    const script =
      `import sys,os,json,pathlib\nsys.path.insert(0,${JSON.stringify(new URL("../../containers/", import.meta.url).pathname)})\nfrom pool import pool_contract\ndef check_tmpfs(path):\n assert str(path)=="/dev/shm"\npool_contract.require_tmpfs=check_tmpfs\ndef fake_exec(executable,args):\n root=pathlib.Path.cwd()\n print(json.dumps({"executable":executable,"args":args,"cwd":str(root),"yaml":(root/"cluster.yaml").read_text(),"mode":(root/"cluster.yaml").stat().st_mode & 511,"directory_mode":root.stat().st_mode & 511}))\nos.execv=fake_exec\nsys.argv=["fixture","-db-schema-check"]\n` +
      f.bootstrap.replace(
        'pathlib.Path("/dev/shm/basalt-schema")',
        `pathlib.Path(${JSON.stringify(join(directory, "native"))})`,
      );
    const result = spawnSync("/usr/bin/python3", ["-c", script], {
      input: JSON.stringify({ database_url: databaseUrl, schema_owner: "basalt_pool_owner" }),
      encoding: "utf8",
      timeout: 5_000,
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(result.status, 0, "Python bootstrap must execute successfully");
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.executable, "/usr/local/bin/cliproxy-home");
    assert.deepEqual(observed.args, ["cliproxy-home", "-db-schema-check"]);
    assert.equal(observed.cwd, realpathSync(join(directory, "native")));
    assert.match(observed.yaml, /pgsql:\n  postgres_uri:/);
    assert.ok(observed.yaml.includes("synthetic-db-secret"));
    assert.ok(observed.yaml.includes("application_name=basalt-home"));
    assert.ok(observed.yaml.includes('schema-owner: "basalt_pool_owner"'));
    assert.equal(observed.mode, 0o600);
    assert.equal(observed.directory_mode, 0o700);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
