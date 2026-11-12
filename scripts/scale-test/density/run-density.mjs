// Keep container ownership and teardown together so partial setup has one cleanup path.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { measurePhase } from "./phase.mjs";
import { prepareProfile } from "./profile.mjs";
const root = process.env.DENSITY_OUTPUT ?? import.meta.dir,
  bin = "docker",
  image = readFileSync(join(root, "image.id"), "utf8").trim();
const inputs = JSON.parse(readFileSync(join(root, "profiles.json"), "utf8"));
const attempt = process.argv[2] ?? "hosted-01",
  functional = process.argv.includes("--functional"),
  out = join(root, "run-" + attempt);
if (!functional && process.arch !== "x64") throw Error("Capacity requires a native x86 runner");
mkdirSync(out, { recursive: false });
const base = "density-53d-" + attempt + "-" + process.pid,
  network = base + "-internal";
const resources = [],
  observers = [],
  results = [];
let pool,
  ports,
  phaseCount = 0,
  networkCreated = false;
const began = Date.now();
const save = (file, data) =>
  writeFileSync(join(out, file), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
function run(args) {
  const x = spawnSync(bin, args, { encoding: "utf8", timeout: 180000, maxBuffer: 4 * 2 ** 20 });
  if (x.status !== 0) {
    save("command-failure-" + Date.now() + ".json", {
      args,
      code: x.status,
      stdout: x.stdout,
      stderr: x.stderr,
    });
    throw Error("Fixture operation failed: " + args[0]);
  }
  return x.stdout.trim();
}
function container(args) {
  const id = run(["run", "--pull=never", "--detach", ...args]);
  resources.push(id);
  save("resources.json", { network, resources, image });
  return id;
}
function origin(id, port) {
  const published = run(["port", id, String(port)]);
  const portNumber = Number(published.slice(published.lastIndexOf(":") + 1));
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)
    throw Error("Invalid loopback fixture port");
  const address = new URL("http://127.0.0.1");
  address.port = String(portNumber);
  return address.origin;
}
async function json(url, options = {}) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  if (!r.ok) {
    await r.body?.cancel();
    throw Error("Fixture HTTP status " + r.status + " at " + new URL(url).pathname);
  }
  return r.json();
}
async function until(work, timeout = 240000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      if (await work()) return;
    } catch (error) {
      last = error.message;
    }
    await delay(500);
  }
  throw Error("Fixture readiness timed out " + (last ?? ""));
}
const management = "synthetic-density-management";
function home(path, body) {
  return json(ports.home + "/v8/management" + path, {
    headers: { "x-management-key": management, "content-type": "application/json" },
    ...(body ? { method: "PATCH", body: JSON.stringify(body) } : {}),
  });
}
async function phase(...dimensions) {
  const result = await measurePhase(
    { out, ports, home, json, attempt, executionStart: began, phaseNumber: ++phaseCount },
    ...dimensions,
  );
  results.push(result);
  save("progress.json", {
    phase: result.name,
    results: results.map(({ telemetry: _telemetry, ownFailures, ...record }) => ({
      ...record,
      failureCount: ownFailures.length,
    })),
  });
  return result;
}

try {
  const dependencyImages = Object.fromEntries(
    ["postgres:17.7-alpine", "node:24.18.0-alpine"].map((tag) => {
      const info = JSON.parse(run(["image", "inspect", tag]))[0];
      return [
        tag,
        { imageId: info.Id, repoDigests: info.RepoDigests, architecture: info.Architecture },
      ];
    }),
  );
  save("prelaunch-dependency-images.json", dependencyImages);
  run(["network", "create", "--internal", network]);
  networkCreated = true;
  if (run(["network", "inspect", network, "--format", "{{.Internal}}"]) !== "true")
    throw Error("Egress boundary not internal");
  const db = container([
    "--name",
    base + "-db",
    "--network",
    network,
    "--network-alias",
    "density-db",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=512m",
    "--env",
    "POSTGRES_USER=fixture_admin",
    "--env",
    "POSTGRES_PASSWORD=fixture-only",
    "--env",
    "POSTGRES_DB=basalt_pool",
    dependencyImages["postgres:17.7-alpine"].imageId,
  ]);
  await until(
    async () =>
      spawnSync(bin, ["exec", db, "pg_isready", "-U", "fixture_admin", "-d", "basalt_pool"], {
        stdio: "ignore",
      }).status === 0,
  );
  run([
    "exec",
    db,
    "psql",
    "-U",
    "fixture_admin",
    "-d",
    "basalt_pool",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "CREATE ROLE basalt_pool_owner NOLOGIN; ALTER DATABASE basalt_pool OWNER TO basalt_pool_owner; GRANT ALL ON SCHEMA public TO basalt_pool_owner",
  ]);
  const mock = container([
    "--name",
    base + "-mock",
    "--network",
    network,
    "--network-alias",
    "density-upstream",
    "--mount",
    `type=bind,source=${root}/provider.mjs,target=/fixture.mjs,readonly`,
    "--mount",
    `type=bind,source=${out},target=/evidence`,
    dependencyImages["node:24.18.0-alpine"].imageId,
    "node",
    "/fixture.mjs",
  ]);
  const relay = container([
    "--name",
    base + "-relay",
    "--network",
    "bridge",
    ...["8080", "8317", "8318", "8327"].flatMap((p) => ["--publish", "127.0.0.1::" + p]),
    "--mount",
    `type=bind,source=${root}/relay.mjs,target=/relay.mjs,readonly`,
    dependencyImages["node:24.18.0-alpine"].imageId,
    "node",
    "/relay.mjs",
  ]);
  run(["network", "connect", network, relay]);
  ports = {
    mock: origin(relay, 8080),
    node: origin(relay, 8317),
    ready: origin(relay, 8318),
    home: origin(relay, 8327),
  };
  await until(() => json(ports.mock + "/stats"));
  save(
    "dependencies.json",
    Object.fromEntries(
      [
        ["database", db],
        ["provider", mock],
        ["relay", relay],
      ].map(([k, id]) => [k, JSON.parse(run(["inspect", id]))[0].Image]),
    ),
  );
  save(
    "engine.json",
    JSON.parse(
      run([
        "info",
        "--format",
        '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"architecture":{{json .Architecture}},"operatingSystem":{{json .OperatingSystem}},"serverVersion":{{json .ServerVersion}}}',
      ]),
    ),
  );
  for (const profile of inputs.profiles) {
    const {
      pool: currentPool,
      observer,
      output,
      controls,
    } = await prepareProfile(
      {
        root,
        out,
        base,
        network,
        image,
        bin,
        management,
        ports,
        container,
        run,
        until,
        json,
        home,
        attempt,
        observers,
        save,
      },
      profile,
    );
    pool = currentPool;
    if (functional) {
      await json(ports.mock + "/flush");
      save("functional-complete.json", {
        profile: profile.name,
        protocols: controls.map((x) => x.protocol),
        controlsPassed: true,
        capacity: null,
        databaseCounters: (await home("/capabilities")).server_info.database_pool,
        scope: "Functional only on emulated amd64; no C reported",
      });
      break;
    }
    for (const workload of inputs.workloads) {
      let last = null,
        baseline = null;
      for (const concurrency of inputs.levels) {
        const r = await phase(profile, workload, concurrency, 90000, "ramp", baseline);
        baseline ??= r;
        if (r.ownFailures.length) throw Error("STOP: model operation failed in " + r.name);
        if (!r.pass) break;
        last = r;
      }
      if (last) {
        const confirm = await phase(
          profile,
          workload,
          last.concurrency,
          330000,
          "confirm",
          baseline,
        );
        save(profile.name + "-" + workload.name + "-capacity.json", {
          confirmed: confirm.pass,
          capacity: confirm.pass ? last.concurrency : null,
          upperBoundReached: last.concurrency === inputs.levels.at(-1),
          confirmation: confirm.name,
          scope: inputs.scope,
        });
        if (confirm.ownFailures.length)
          throw Error("STOP: model operation failed in " + confirm.name);
      } else
        save(profile.name + "-" + workload.name + "-capacity.json", {
          confirmed: false,
          capacity: null,
          reason: "Lowest ramp level failed",
        });
    }
    run(["stop", "--time", "15", pool]);
    writeFileSync(join(out, "container-" + pool.slice(0, 12) + ".log"), run(["logs", pool]), {
      mode: 0o600,
    });
    observer.kill("SIGTERM");
    output.end();
    run(["rm", "--volumes", pool]);
    resources.splice(resources.indexOf(pool), 1);
    pool = null;
  }
  save("complete.json", {
    complete: true,
    mode: functional ? "functional" : "density",
    phaseCount,
    elapsedSeconds: (Date.now() - began) / 1000,
    results: results.map(({ telemetry: _telemetry, ownFailures, ...x }) => ({
      ...x,
      failureCount: ownFailures.length,
    })),
  });
} catch (error) {
  save("failure.json", {
    at: Date.now(),
    message: error.message,
    phaseCount,
    elapsedSeconds: (Date.now() - began) / 1000,
  });
  process.exitCode = 1;
  console.error(error.message);
} finally {
  const cleanup = [];
  for (const observer of observers) observer.kill("SIGTERM");
  for (const id of [...resources].reverse()) {
    try {
      writeFileSync(join(out, "container-" + id.slice(0, 12) + ".log"), run(["logs", id]), {
        mode: 0o600,
      });
      run(["rm", "--force", "--volumes", id]);
      cleanup.push({ id, removed: true });
    } catch (error) {
      cleanup.push({ id, removed: false, error: error.message });
    }
  }
  if (networkCreated)
    try {
      run(["network", "rm", network]);
      cleanup.push({ network, removed: true });
    } catch (error) {
      cleanup.push({ network, removed: false, error: error.message });
    }
  save("cleanup.json", { cleanup, complete: cleanup.every((x) => x.removed) });
}
