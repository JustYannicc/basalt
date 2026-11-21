import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
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
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sharedStepCache, withSharedStep } from "./shared-step-cache.ts";

const module = fileURLToPath(new URL("./shared-step-cache.ts", import.meta.url));
// A child process that runs one cached step: the build appends to a log, sleeps, writes its output.
const worker = (directory: string) => {
  const path = join(directory, "worker.ts");
  writeFileSync(
    path,
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withSharedStep } from ${JSON.stringify(module)};
const [root, key, log] = process.argv.slice(2);
withSharedStep({ cache: process.env.STEP_CACHE, key, root, outputs: ["out/file.json"] }, () => {
  appendFileSync(log, "built\\n");
  if (process.env.FAIL) process.exit(3);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.BUILD_MS ?? 0));
  mkdirSync(join(root, "out"), { recursive: true });
  writeFileSync(join(root, "out/file.json"), key + " " + process.pid);
});
`,
  );
  return path;
};
const sandbox = (run: (directory: string) => Promise<void> | void) => async () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-shared-step-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const runSync = (directory: string, root: string, key: string, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [worker(directory), root, key, join(directory, "built.log")], {
    env: { PATH: process.env.PATH, STEP_CACHE: join(directory, "cache"), ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
const runAsync = (directory: string, root: string, key: string, env: Record<string, string>) =>
  new Promise<number | null>((resolve) =>
    spawn(process.execPath, [worker(directory), root, key, join(directory, "built.log")], {
      env: { PATH: process.env.PATH, STEP_CACHE: join(directory, "cache"), ...env },
      stdio: "ignore",
    }).once("exit", resolve),
  );
const builds = (directory: string) =>
  existsSync(join(directory, "built.log"))
    ? readFileSync(join(directory, "built.log"), "utf8").trim().split("\n").length
    : 0;
const locks = (directory: string) =>
  existsSync(join(directory, "cache"))
    ? readdirSync(join(directory, "cache"), { recursive: true, encoding: "utf8" }).filter((name) =>
        name.endsWith(".lock"),
      )
    : [];

test(
  "with no cache named, the step builds every time and nothing is written",
  sandbox((directory) => {
    const root = join(directory, "root");
    for (const cache of [undefined, ""]) {
      let built = 0;
      for (let run = 0; run < 2; run++)
        withSharedStepIn(root, cache, "k", () => {
          built++;
          mkdirSync(join(root, "out"), { recursive: true });
          writeFileSync(join(root, "out/file.json"), "fresh");
        });
      assert.equal(built, 2, String(cache));
    }
    assert.equal(existsSync(join(directory, "cache")), false);
  }),
);

test(
  "a restored entry answers only its own key",
  sandbox((directory) => {
    const root = join(directory, "root");
    assert.equal(runSync(directory, root, "a").status, 0);
    rmSync(join(root, "out"), { recursive: true });
    assert.equal(runSync(directory, root, "a").status, 0);
    assert.equal(builds(directory), 1);
    assert.match(readFileSync(join(root, "out/file.json"), "utf8"), /^a /);
    // Another key never restores the first one's output.
    assert.equal(runSync(directory, root, "b").status, 0);
    assert.equal(builds(directory), 2);
    assert.match(readFileSync(join(root, "out/file.json"), "utf8"), /^b /);
  }),
);

test(
  "two jobs at once build the step once and end with the same output",
  sandbox(async (directory) => {
    const roots = [join(directory, "first"), join(directory, "second")];
    const codes = await Promise.all(
      roots.map((root) => runAsync(directory, root, "k", { BUILD_MS: "500" })),
    );
    assert.deepEqual(codes, [0, 0]);
    assert.equal(builds(directory), 1);
    assert.equal(
      readFileSync(join(roots[0]!, "out/file.json"), "utf8"),
      readFileSync(join(roots[1]!, "out/file.json"), "utf8"),
    );
    assert.deepEqual(locks(directory), []);
  }),
);

test(
  "a failed build releases its lock; a dead holder's lock is taken over after the bound",
  sandbox(async (directory) => {
    const root = join(directory, "root");
    assert.notEqual(runSync(directory, root, "k", { FAIL: "1" }).status, 0);
    assert.deepEqual(locks(directory), []);
    // A lock a killed holder left, with its owner inside, as a real one has.
    const cache = join(directory, "cache");
    const lock = join(cache, "k.lock");
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), "a killed job");
    const old = new Date(Date.now() - 10_000);
    utimesSync(lock, old, old);
    const result = runSync(directory, root, "k", { BASALT_STEP_LOCK_STALE_MS: "5000" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Taking over a lock held for \d+s/);
    assert.deepEqual(locks(directory), []);
    // A live holder is waited for, and its entry restored once it lands.
    rmSync(cache, { recursive: true });
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "owner"), "a live job");
    const before = builds(directory);
    const waiting = runAsync(directory, root, "k", {});
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(builds(directory), before);
    mkdirSync(join(cache, "k/out"), { recursive: true });
    writeFileSync(join(cache, "k/out/file.json"), "from the live job");
    rmSync(lock, { recursive: true });
    assert.equal(await waiting, 0);
    assert.equal(builds(directory), before);
    assert.equal(readFileSync(join(root, "out/file.json"), "utf8"), "from the live job");
  }),
);

test("the box's shared directory names the cache; elsewhere there is none", () => {
  const env = (extra: Record<string, string | undefined>) => ({ GITHUB_RUN_ID: "77", ...extra });
  const shared = mkdtempSync(join(tmpdir(), "basalt-box-shared-"));
  try {
    assert.equal(
      sharedStepCache(
        "framework",
        env({ RUNNER_ENVIRONMENT: "self-hosted", BASALT_BOX_SHARED: shared }),
      ),
      join(shared, "framework", "77"),
    );
    for (const extra of [
      { RUNNER_ENVIRONMENT: "github-hosted", BASALT_BOX_SHARED: shared },
      { RUNNER_ENVIRONMENT: "self-hosted", BASALT_BOX_SHARED: undefined },
      { RUNNER_ENVIRONMENT: "self-hosted", BASALT_BOX_SHARED: join(shared, "missing") },
      { RUNNER_ENVIRONMENT: "self-hosted", BASALT_BOX_SHARED: shared, GITHUB_RUN_ID: "" },
      { RUNNER_ENVIRONMENT: undefined, BASALT_BOX_SHARED: shared },
    ])
      assert.equal(sharedStepCache("framework", env(extra)), undefined, JSON.stringify(extra));
  } finally {
    rmSync(shared, { recursive: true, force: true });
  }
});

const withSharedStepIn = (
  root: string,
  cache: string | undefined,
  key: string,
  build: () => void,
) => withSharedStep({ cache, key, root, outputs: ["out/file.json"] }, build);
