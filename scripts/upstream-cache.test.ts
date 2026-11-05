import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installUpstreamDependencies } from "./upstream-dependencies.ts";
import { prepareUpstreamCheckout, withCacheLock } from "./upstream-cache.ts";

test("two carried checkouts share installed package bytes and retain their own workspace source", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-upstream-share-"));
  t.after(() => {
    execFileSync("chmod", ["-R", "u+w", directory]);
    rmSync(directory, { recursive: true, force: true });
  });
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  process.env.BASALT_UPSTREAM_CACHE = join(directory, "cache");
  t.after(() => {
    if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previous;
  });
  const repository = join(directory, "repository");
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(
    join(repository, "package.json"),
    JSON.stringify({
      name: "fixture",
      workspaces: ["packages/*"],
      dependencies: { "is-number": "7.0.0", "is-odd": "3.0.1", "fixture-own": "workspace:*" },
    }),
  );
  mkdirSync(join(repository, "packages/own"), { recursive: true });
  writeFileSync(
    join(repository, "packages/own/package.json"),
    JSON.stringify({ name: "fixture-own", version: "1.0.0", exports: "./index.js" }),
  );
  writeFileSync(join(repository, "packages/own/index.js"), 'export const name="original";');
  execFileSync("bun", ["install"], { cwd: repository, stdio: "pipe" });
  git("add", "package.json", "bun.lock", "packages");
  git("commit", "-qm", "fixture");
  const pin = { repository, commit: git("rev-parse", "HEAD") };
  const first = join(directory, "one/.upstream"),
    second = join(directory, "two/.upstream");
  await prepareUpstreamCheckout(first, pin);
  await prepareUpstreamCheckout(second, pin);
  const legacy = join(directory, "legacy/.upstream");
  execFileSync("git", ["clone", "--no-hardlinks", repository, legacy], { stdio: "pipe" });
  execFileSync("git", ["-C", legacy, "branch", "retained-owner-ref"]);
  await prepareUpstreamCheckout(legacy, pin);
  assert.equal(
    execFileSync("git", ["-C", legacy, "rev-parse", "retained-owner-ref"], {
      encoding: "utf8",
    }).trim(),
    pin.commit,
  );
  const a = await installUpstreamDependencies(first, pin.commit);
  const b = await installUpstreamDependencies(second, pin.commit);
  assert.equal(a.store, b.store);
  const originalPackage = realpathSync(join(second, "node_modules/is-number"));
  const reader = spawn(
    process.execPath,
    [
      "-e",
      `
    const fs = require("node:fs");
    process.on("message", () => {
      process.send(fs.readFileSync(${JSON.stringify(join(second, "node_modules/is-number/index.js"))}, "utf8"));
    });
    process.send("ready");
  `,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  t.after(() => {
    if (reader.exitCode === null && reader.signalCode === null) reader.kill("SIGKILL");
  });
  await once(reader, "message");
  writeFileSync(join(a.store, "ready.json"), "{");
  const recovered = await installUpstreamDependencies(first, pin.commit);
  assert.equal(JSON.parse(readFileSync(join(recovered.store, "ready.json"), "utf8")).key, a.key);
  // An interrupted publication may leave read-only packages without a completion marker.
  assert.notEqual(recovered.store, a.store);
  assert.equal(realpathSync(join(second, "node_modules/is-number")), originalPackage);
  unlinkSync(join(recovered.store, "ready.json"));
  await installUpstreamDependencies(first, pin.commit);
  assert.equal(existsSync(a.store), true, "the second consumer still uses the original generation");
  assert.equal(
    existsSync(recovered.store),
    false,
    "no consumer uses the replaced recovered generation",
  );
  const read = once(reader, "message");
  reader.send("read");
  assert.equal((await read)[0], readFileSync(join(originalPackage, "index.js"), "utf8"));
  const readerExit = once(reader, "exit");
  reader.kill("SIGTERM");
  await readerExit;
  await installUpstreamDependencies(second, pin.commit);
  assert.equal(
    existsSync(a.store),
    false,
    "all consumers have moved away from the original generation",
  );
  assert.equal(
    realpathSync(join(first, "node_modules/is-number")),
    realpathSync(join(second, "node_modules/is-number")),
  );
  writeFileSync(join(first, "packages/own/index.js"), 'export const name="changed";');
  assert.equal(
    readFileSync(join(second, "packages/own/index.js"), "utf8"),
    'export const name="original";',
  );
  assert.notEqual(
    realpathSync(join(first, "node_modules/fixture-own")),
    realpathSync(join(second, "node_modules/fixture-own")),
  );
  assert.equal(lstatSync(join(first, ".git")).isFile(), true);
  writeFileSync(
    join(first, "package.json"),
    JSON.stringify({
      name: "fixture",
      workspaces: ["packages/*"],
      dependencies: { "is-number": "7.0.0", "is-odd": "3.0.1", "fixture-own": "workspace:*" },
      private: true,
    }),
  );
  const changed = await installUpstreamDependencies(first, pin.commit);
  assert.notEqual(changed.key, a.key);
});

test("concurrent cache waiters recover one dead owner without removing the next owner's lock", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-cache-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lock = join(directory, "install.lock");
  const pid = Number(
    execFileSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }),
  );
  const { symlinkSync } = await import("node:fs");
  symlinkSync(JSON.stringify({ pid, id: "dead-fixture" }), lock);
  let active = 0;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      withCacheLock(lock, async () => {
        assert.equal(++active, 1);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(active--, 1);
      }),
    ),
  );
});
