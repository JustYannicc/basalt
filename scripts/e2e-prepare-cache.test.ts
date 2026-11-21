import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Carry 0722: jobs of one Check that name a cache in `$EXECUTOR_E2E_CACHE` build each e2e:prepare
// step once. These run the carried upstream script against a small fixture workspace.
const script = fileURLToPath(new URL("../.upstream/scripts/e2e-prepare.ts", import.meta.url));
const steps = {
  "apps:build": "packages/apps/dist/index.js",
  "telemetry:build": "packages/telemetry/dist/motel/index.js",
  "e2e:runtime": ".local/test-runtime/host.json",
  "e2e:apps": ".local/test-runtime/apps.tgz",
  "hosted:self-host:web:build": "apps/hosted/self-host/web/dist/server/server.js",
  "web:build": "apps/local/web/dist/index.html",
  "e2e:npm": ".local/test-runtime/npm/package.tgz",
};

/** A git workspace with the seven steps, each a fake build that logs to `$BUILD_LOG`. */
function workspace(parent: string, name: string) {
  const root = join(parent, name);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const packages: Record<string, string[]> = {
    "packages/apps": [],
    "packages/sdk": ["apps"],
    "packages/ui": [],
    "packages/telemetry": [],
    "apps/local/web": ["ui"],
    "apps/hosted/self-host/web": ["ui"],
  };
  for (const [path, dependencies] of Object.entries(packages)) {
    const name =
      path === "packages/apps" ? "apps" : path === "packages/ui" ? "ui" : path.replaceAll("/", "-");
    write(
      `${path}/package.json`,
      JSON.stringify({
        name,
        dependencies: Object.fromEntries(dependencies.map((name) => [name, "workspace:*"])),
      }),
    );
    write(`${path}/index.ts`, "export const value = 1;\n");
  }
  write(
    "package.json",
    JSON.stringify({
      type: "module",
      workspaces: ["packages/*", "apps/local/web", "apps/hosted/self-host/web"],
      scripts: Object.fromEntries(
        Object.entries(steps).map(([step, output]) => [step, `node build.mjs ${step} ${output}`]),
      ),
    }),
  );
  // Each build sleeps briefly so that two concurrent preparations overlap.
  write(
    "build.mjs",
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const [step, output] = process.argv.slice(2);
if (process.env.FAKE_FAIL === step) process.exit(3);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.BUILD_MS ?? 0));
mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, step + ' ' + process.env.BUILD_MARK);
if (step === 'e2e:runtime') writeFileSync(output + '.map', '{}');
if (step === 'hosted:self-host:web:build') writeFileSync('apps/hosted/self-host/web/routeTree.gen.ts', 'generated route source');
appendFileSync(process.env.BUILD_LOG, step + '\\n');
`,
  );
  for (const path of [
    "bun.lock",
    "tsconfig.json",
    "e2e/npm-packages.json",
    "packages/telemetry/motel/source.json",
  ])
    write(path, "{}\n");
  write(".gitignore", "dist/\n.local/\n");
  write("apps/hosted/self-host/package.json", JSON.stringify({ type: "module" }));
  for (const path of [
    "patches/fake.patch",
    "playground/demo-apps/live-inbox/index.ts",
    "scripts/build-test-runtime.ts",
    "scripts/pack-test-apps.ts",
    "scripts/e2e-npm-packages.ts",
  ])
    write(path, "\n");
  cpSync(script, join(root, "scripts/e2e-prepare.ts"));
  const git = (args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(["init", "--quiet"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=CI fixture",
    "-c",
    "user.email=ci@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Fixture",
  ]);
  return root;
}

type Environment = Record<string, string | undefined>;
const base = (parent: string, extra: Environment): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(parent, "home"),
    BUILD_LOG: join(parent, "built.log"),
  };
  for (const [name, value] of Object.entries(extra))
    if (value === undefined) delete env[name];
    else env[name] = value;
  return env;
};
const prepareSync = (root: string, parent: string, extra: Environment) => {
  const result = spawnSync(process.execPath, ["scripts/e2e-prepare.ts"], {
    cwd: root,
    env: base(parent, extra),
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const prepare = (root: string, parent: string, extra: Environment) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/e2e-prepare.ts"], {
      cwd: root,
      env: base(parent, extra),
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
const built = (parent: string) =>
  existsSync(join(parent, "built.log"))
    ? readFileSync(join(parent, "built.log"), "utf8").trim().split("\n")
    : [];
const outputs = (root: string) =>
  Object.values(steps).map((path) => readFileSync(join(root, path), "utf8"));

function sandbox(run: (parent: string) => Promise<void> | void) {
  return async () => {
    const parent = mkdtempSync(join(tmpdir(), "basalt-e2e-prepare-cache-"));
    try {
      await run(parent);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  };
}

test(
  "with EXECUTOR_E2E_CACHE unset or empty, CI builds every step and leaves no cache, as before",
  sandbox((parent) => {
    const root = workspace(parent, "a");
    for (const cache of [undefined, ""]) {
      rmSync(join(parent, "built.log"), { force: true });
      const output = prepareSync(root, parent, { CI: "true", EXECUTOR_E2E_CACHE: cache });
      assert.match(output, /, without the cache\.$/m, String(cache));
      assert.deepEqual(built(parent), Object.keys(steps), String(cache));
      assert.equal(existsSync(join(parent, "home/.cache")), false, String(cache));
    }
    // Outside CI an unset variable still means the default cache under the home directory.
    rmSync(join(parent, "built.log"), { force: true });
    const local = prepareSync(root, parent, { CI: undefined, EXECUTOR_E2E_CACHE: undefined });
    assert.match(local, new RegExp(`cache ${join(parent, "home/.cache/executor-e2e-prepare")}\\.`));
    assert.match(prepareSync(root, parent, { CI: undefined }), /apps:build: cached/);
  }),
);

test(
  "CI uses a cache it names, and never serves an entry after one of its inputs changed",
  sandbox((parent) => {
    const root = workspace(parent, "a");
    const cache = { CI: "true", EXECUTOR_E2E_CACHE: join(parent, "shared") };
    prepareSync(root, parent, cache);
    assert.deepEqual(built(parent), Object.keys(steps));
    rmSync(join(parent, "built.log"));
    // Nothing changed: every step restores.
    const again = prepareSync(root, parent, cache);
    for (const step of Object.keys(steps)) assert.match(again, new RegExp(`${step}: cached`));
    assert.deepEqual(built(parent), []);
    // A change in ui reaches both dashboards and nothing else.
    writeFileSync(join(root, "packages/ui/index.ts"), "export const value = 2;\n");
    const changed = prepareSync(root, parent, cache);
    assert.deepEqual(built(parent).sort(), ["hosted:self-host:web:build", "web:build"]);
    assert.match(changed, /apps:build: cached/);
    assert.match(changed, /web:build: built/);
  }),
);

test(
  "two jobs preparing at once build each step exactly once and end with the same outputs",
  sandbox(async (parent) => {
    const first = workspace(parent, "a");
    const second = workspace(parent, "b");
    const cache = (mark: string) => ({
      CI: "true",
      EXECUTOR_E2E_CACHE: join(parent, "shared"),
      BUILD_MS: "300",
      BUILD_MARK: mark,
    });
    await Promise.all([prepare(first, parent, cache("a")), prepare(second, parent, cache("b"))]);
    const log = built(parent);
    for (const step of Object.keys(steps))
      assert.equal(log.filter((line) => line === step).length, 1, step);
    assert.deepEqual(outputs(first), outputs(second));
  }),
);

test(
  "a lock its holder left behind is taken over after the bound; a live one is waited for",
  sandbox(async (parent) => {
    const root = workspace(parent, "a");
    const shared = join(parent, "shared");
    const cache = { CI: "true", EXECUTOR_E2E_CACHE: shared };
    prepareSync(root, parent, cache);
    // Turn every entry into a lock with no entry, as a holder that died mid-build leaves it. The
    // self-host web step also stores under its post-build key, which nobody claims, so its entries
    // are only removed.
    const locks: string[] = [];
    for (const step of readdirSync(shared))
      for (const entry of readdirSync(join(shared, step))) {
        rmSync(join(shared, step, entry), { recursive: true });
        if (step === "hosted:self-host:web:build") continue;
        const lock = join(shared, step, `${entry}.lock`);
        mkdirSync(lock);
        locks.push(lock);
      }
    const old = new Date(Date.now() - 60_000);
    for (const lock of locks) utimesSync(lock, old, old);
    rmSync(join(parent, "built.log"));
    const output = prepareSync(root, parent, { ...cache, EXECUTOR_E2E_LOCK_STALE_MS: "30000" });
    assert.match(output, /Taking over a lock held for \d+s/);
    assert.deepEqual(built(parent), Object.keys(steps));
    for (const lock of locks) assert.equal(existsSync(lock), false, lock);
    // A fresh lock is waited for: once its holder finishes, the waiter restores its entry.
    const step = readdirSync(shared).find((name) => name === "apps:build")!;
    const [entry] = readdirSync(join(shared, step));
    const held = join(shared, step, `${entry}.lock`);
    const parked = join(parent, "parked");
    cpSync(join(shared, step, entry!), parked, { recursive: true });
    rmSync(join(shared, step, entry!), { recursive: true });
    mkdirSync(held);
    rmSync(join(parent, "built.log"));
    const waiting = prepare(root, parent, { ...cache, EXECUTOR_E2E_LOCK_STALE_MS: "600000" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(built(parent), []);
    cpSync(parked, join(shared, step, entry!), { recursive: true });
    rmSync(held, { recursive: true });
    assert.match(await waiting, /apps:build: cached/);
    assert.equal(built(parent).includes("apps:build"), false);
  }),
);

test("box jobs share one cache directory per Check; hosted jobs name none", () => {
  const action = readFileSync(
    new URL("../.github/actions/setup-bun/action.yml", import.meta.url),
    "utf8",
  );
  const step = action.slice(action.indexOf("- name: Share e2e build outputs"));
  assert.match(step, /if: runner\.environment == 'self-hosted'/);
  assert.match(
    step,
    /echo "EXECUTOR_E2E_CACHE=\$BASALT_BOX_SHARED\/e2e-prepare\/\$GITHUB_RUN_ID" >> "\$GITHUB_ENV"/,
  );
  // Only the box's shared mount turns it on, and only when the directory is really there.
  assert.match(step, /\[ -n "\$\{BASALT_BOX_SHARED:-\}" \] && \[ -d "\$BASALT_BOX_SHARED" \]/);
  assert.equal(action.match(/EXECUTOR_E2E_CACHE/g)?.length, 1);
});

const locksIn = (directory: string): string[] =>
  existsSync(directory)
    ? readdirSync(directory, { recursive: true, encoding: "utf8" }).filter((name) =>
        name.endsWith(".lock"),
      )
    : [];

test(
  "a failed or killed build releases its lock, so the next run neither waits nor hangs",
  sandbox(async (parent) => {
    const root = workspace(parent, "a");
    const shared = join(parent, "shared");
    const cache = { CI: "true", EXECUTOR_E2E_CACHE: shared };
    const failed = spawnSync(process.execPath, ["scripts/e2e-prepare.ts"], {
      cwd: root,
      env: base(parent, { ...cache, FAKE_FAIL: "apps:build" }),
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.notEqual(failed.status, 0);
    assert.deepEqual(locksIn(shared), []);
    // With the default five-minute bound, a leftover lock would stall this run past its timeout.
    const started = Date.now();
    const output = prepareSync(root, parent, cache);
    assert.doesNotMatch(output, /Waiting for another job/);
    assert.ok(Date.now() - started < 30_000);
    // A holder killed mid-build releases its lock too.
    rmSync(shared, { recursive: true });
    const child = spawn(process.execPath, ["scripts/e2e-prepare.ts"], {
      cwd: root,
      env: base(parent, { ...cache, BUILD_MS: "5000" }),
    });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    for (let tries = 0; locksIn(shared).length === 0 && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(locksIn(shared).length, 1);
    child.kill("SIGTERM");
    await exited;
    assert.deepEqual(locksIn(shared), []);
  }),
);
