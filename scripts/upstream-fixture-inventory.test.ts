import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureInventory } from "./upstream-fixture-inventory.ts";

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
