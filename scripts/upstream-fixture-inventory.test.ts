import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureInventory } from "./upstream-fixture-inventory.ts";
import { collectUpstreamDependencies } from "./upstream-store.ts";

test("fixture inventory observes real held FDs and only its registered checkouts", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "basalt-inventory-proof-")));
  const inventory = fixtureInventory(t, root);
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  inventory.checkout(checkout);
  const path = join(checkout, "held-package");
  writeFileSync(path, "real package bytes");
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import { openSync, closeSync } from "node:fs";
const fd = openSync(${JSON.stringify(path)}, "r");
process.on("message", message => {
  if (message === "close") { closeSync(fd); process.send("closed"); }
  else process.exit(0);
});
process.send("held");
`,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  inventory.track(child.pid!);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal((await once(child, "message"))[0], "held");
  const handles = () => execFileSync("lsof", ["-nP", "-F0n"], { encoding: "utf8" });
  assert.ok(handles().includes(`n${path}\0`), "the real open descriptor must be observed");
  const closed = once(child, "message");
  child.send("close");
  assert.equal((await closed)[0], "closed");
  assert.ok(!handles().includes(`n${path}\0`), "closed descriptors must leave the snapshot");
  const repository = fileURLToPath(new URL("../", import.meta.url));
  const roots = execFileSync("git", ["-C", repository, "worktree", "list", "--porcelain", "-z"], {
    encoding: "utf8",
  });
  assert.equal(roots, `worktree ${checkout}\0\0`);
  const exited = once(child, "exit");
  child.send("exit");
  await exited;
  assert.equal(child.exitCode, 0);
  assert.ok(
    !handles().includes(`n${path}\0`),
    "an exited fixture PID must not invalidate collection",
  );
});

for (const failure of ["exit", "stderr"] as const)
  test(`unverifiable fixture usage (${failure}) preserves the entire cache until observation recovers`, async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "basalt-inventory-refusal-")));
    const inventory = fixtureInventory(t, root);
    const previous = process.env.BASALT_UPSTREAM_CACHE;
    process.env.BASALT_UPSTREAM_CACHE = join(root, "cache");
    t.after(() => {
      if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
      else process.env.BASALT_UPSTREAM_CACHE = previous;
      rmSync(root, { recursive: true, force: true });
    });
    const entry = join(root, "cache/prepared/pin/key");
    const generation = join(entry, "generations/unused");
    const attempt = join(entry, "attempts/abandoned");
    mkdirSync(generation, { recursive: true });
    mkdirSync(attempt, { recursive: true });
    writeFileSync(join(entry, "store-format.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(generation, "payload"), "unused generation");
    writeFileSync(join(attempt, "payload"), "abandoned attempt");
    inventory.usageFailure(failure);
    assert.equal(await collectUpstreamDependencies(), false);
    assert.equal(existsSync(generation), true, "unknown usage must preserve unused generations");
    assert.equal(existsSync(attempt), true, "unknown usage must prevent partial attempt cleanup");
    inventory.usageFailure("");
    assert.equal(await collectUpstreamDependencies(), true);
    assert.equal(existsSync(entry), false, "complete evidence permits the same cleanup");
  });

test("fixture process enumeration includes captured owners and excludes unrelated processes", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "basalt-inventory-processes-")));
  const inventory = fixtureInventory(t, root, { processTable: true });
  const start = () =>
    spawn(
      process.execPath,
      ["-e", "process.on('message',()=>process.exit(0));process.send('ready')"],
      {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
  const owned = start(),
    unrelated = start();
  inventory.track(owned.pid!);
  t.after(() => {
    for (const child of [owned, unrelated])
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([once(owned, "message"), once(unrelated, "message")]);
  for (const flag of ["-axo", "-eo"]) {
    const pids = execFileSync("ps", [flag, "pid=,pgid=,stat="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((line) => Number(line.trim().split(/\s+/)[0]));
    assert.ok(pids.includes(owned.pid!), "captured owners must remain observable");
    assert.ok(
      !pids.includes(unrelated.pid!),
      "unrelated process churn must not enter the snapshot",
    );
  }
});
