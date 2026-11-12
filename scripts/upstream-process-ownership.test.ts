import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectUpstreamDependencies } from "./upstream-store.ts";
import { withCacheLock } from "./upstream-cache.ts";
import { bootIdentity, readProcessOwner } from "./process-owner.ts";
import { fixtureInventory } from "./upstream-fixture-inventory.ts";

function unrelatedProcess() {
  return spawn(
    process.execPath,
    ["-e", `process.on('message', () => process.exit(0)); process.send('ready');`],
    {
      detached: true,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
}

function stop(child: ReturnType<typeof spawn>) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("recycled parent and group numbers do not retain abandoned attempts", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "basalt-recycled-owners-"));
  const inventory = fixtureInventory(t, fixture, { processTable: true });
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  const child = unrelatedProcess();
  inventory.track(child.pid!);
  t.after(() => {
    stop(child);
    if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previous;
    rmSync(fixture, { recursive: true, force: true });
  });
  await once(child, "message");
  process.env.BASALT_UPSTREAM_CACHE = join(fixture, "cache");
  const entry = join(process.env.BASALT_UPSTREAM_CACHE, "prepared/pin/key");
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, "store-format.json"), JSON.stringify({ version: 3 }));
  const current = readProcessOwner(child.pid!)!;
  const protectedAttempt = join(entry, "attempts/current-parent");
  mkdirSync(protectedAttempt, { recursive: true });
  writeFileSync(join(protectedAttempt, "parent.json"), JSON.stringify(current));
  for (const kind of ["parent", "installer"]) {
    for (const incarnation of ["boot", "start"]) {
      const attempt = join(entry, "attempts", `${kind}-${incarnation}`);
      mkdirSync(attempt, { recursive: true });
      writeFileSync(join(attempt, "package-bytes"), "abandoned payload");
      writeFileSync(
        join(attempt, `${kind}.json`),
        JSON.stringify({
          pid: child.pid,
          group: child.pid,
          boot: incarnation === "boot" ? "previous-boot" : bootIdentity(),
          start: incarnation === "start" ? "0" : current.start,
          token: "previous-installer-incarnation",
        }),
      );
      await collectUpstreamDependencies();
      assert.equal(existsSync(attempt), false, `${kind} ${incarnation} mismatch must expire`);
      assert.equal(existsSync(protectedAttempt), true, "a matching live parent keeps its attempt");
      assert.equal(
        child.exitCode,
        null,
        "the unrelated process must remain alive during collection",
      );
    }
  }
});

for (const incarnation of ["boot", "start"]) {
  test(
    `collection and recovery locks ignore a live PID from another ${incarnation} incarnation`,
    { timeout: 5000 },
    async (t) => {
      const fixture = mkdtempSync(join(tmpdir(), "basalt-recycled-lock-"));
      const owner = unrelatedProcess();
      t.after(() => {
        stop(owner);
        rmSync(fixture, { recursive: true, force: true });
      });
      await once(owner, "message");
      const lock = join(fixture, "collection.lock");
      const stale = JSON.stringify({
        pid: owner.pid,
        boot: incarnation === "boot" ? "previous-boot" : bootIdentity(),
        start: incarnation === "start" ? "0" : readProcessOwner(owner.pid!)!.start,
        id: "previous-lock-incarnation",
      });
      symlinkSync(stale, lock);
      symlinkSync(stale, `${lock}.recovery`);
      await withCacheLock(lock, () => {
        assert.equal(
          JSON.parse(readlinkSync(lock)).pid,
          process.pid,
          "the expired lock has been acquired",
        );
        assert.equal(
          lstatSync(`${lock}.recovery`, { throwIfNoEntry: false }),
          undefined,
          "stale recovery ownership was released",
        );
        assert.equal(
          owner.exitCode,
          null,
          "lock recovery cannot wait for the unrelated process to exit",
        );
      });
      assert.equal(lstatSync(lock, { throwIfNoEntry: false }), undefined);
      assert.equal(lstatSync(`${lock}.recovery`, { throwIfNoEntry: false }), undefined);
    },
  );
}

test("a recycled leaderless group cannot borrow a previous installer's lease", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "basalt-recycled-group-"));
  const inventory = fixtureInventory(t, fixture, { processTable: true });
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  let orphan: number | undefined;
  const leader = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {spawn} from 'node:child_process';
    import {once} from 'node:events';
    const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 60000); process.send('ready');"], {stdio:['ignore','ignore','inherit','ipc']});
    await once(child, 'message');
    process.send({pid:child.pid,group:process.pid}, () => process.exit(0));
  `,
    ],
    { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  t.after(() => {
    stop(leader);
    if (orphan) {
      try {
        process.kill(orphan, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previous;
    rmSync(fixture, { recursive: true, force: true });
  });
  const [{ pid, group }] = (await once(leader, "message")) as [{ pid: number; group: number }];
  orphan = pid;
  inventory.track(orphan);
  if (leader.exitCode === null) await once(leader, "exit");
  process.env.BASALT_UPSTREAM_CACHE = join(fixture, "cache");
  const entry = join(process.env.BASALT_UPSTREAM_CACHE, "prepared/pin/key");
  const attempt = join(entry, "attempts/recycled-group");
  mkdirSync(attempt, { recursive: true });
  writeFileSync(join(entry, "store-format.json"), JSON.stringify({ version: 3 }));
  writeFileSync(
    join(attempt, "installer.json"),
    JSON.stringify({
      pid: group,
      group,
      boot: bootIdentity(),
      start: "0",
      token: "previous-installer-incarnation",
    }),
  );
  await collectUpstreamDependencies();
  assert.equal(existsSync(attempt), false);
  assert.ok(readProcessOwner(orphan), "the unrelated orphan must still be alive");
});
