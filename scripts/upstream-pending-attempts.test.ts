import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installUpstreamDependencies } from "./upstream-dependencies.ts";
import { collectUpstreamDependencies } from "./upstream-store.ts";
import { readProcessOwner } from "./process-owner.ts";

const ownerProcess = () =>
  spawn(
    process.execPath,
    ["-e", "process.on('message',()=>process.exit(0));process.send('ready');"],
    { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
const stop = (child: ReturnType<typeof spawn>) => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};
function failedEnumeration(bin: string) {
  mkdirSync(bin);
  const ps = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "ps"),
    `#!/usr/bin/env node\nconst{spawnSync}=require('node:child_process');\nif(process.argv[2]==='-axo'||process.argv[2]==='-eo')process.exit(1);\nconst r=spawnSync(${JSON.stringify(ps)},process.argv.slice(2),{stdio:'inherit'});process.exit(r.status??1);\n`,
    { mode: 0o755 },
  );
}

for (const mismatch of ["boot", "start"])
  test(`an expired ${mismatch} cannot make an unrelated unreadable group block collection`, async (t) => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "basalt-expired-group-")));
    const previousPath = process.env.PATH,
      previousCache = process.env.BASALT_UPSTREAM_CACHE;
    const child = ownerProcess();
    t.after(() => {
      stop(child);
      process.env.PATH = previousPath;
      if (previousCache === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
      else process.env.BASALT_UPSTREAM_CACHE = previousCache;
      rmSync(fixture, { recursive: true, force: true });
    });
    await once(child, "message");
    const owner = readProcessOwner(child.pid!)!;
    const entry = join(fixture, "cache/prepared/pin/key"),
      attempt = join(entry, "attempts/expired"),
      generation = join(entry, "generations/unreferenced");
    mkdirSync(attempt, { recursive: true });
    mkdirSync(generation, { recursive: true });
    writeFileSync(join(entry, "store-format.json"), JSON.stringify({ version: 3 }));
    writeFileSync(
      join(attempt, "installer.json"),
      JSON.stringify({
        ...owner,
        group: child.pid,
        boot: mismatch === "boot" ? "previous-boot" : owner.boot,
        start: mismatch === "start" ? "0" : owner.start,
        token: "expired-installer",
      }),
    );
    const bin = join(fixture, "bin");
    failedEnumeration(bin);
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.BASALT_UPSTREAM_CACHE = join(fixture, "cache");
    await collectUpstreamDependencies();
    assert.equal(
      existsSync(attempt),
      false,
      "a provably expired lease must not require group enumeration",
    );
    assert.equal(existsSync(generation), false);
    process.env.PATH = previousPath;
    const root = join(fixture, "consumer");
    mkdirSync(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "expired-owner-fixture",
        scripts: {
          prepare:
            'node -e \'require("node:fs").writeFileSync("attempt-payload",Buffer.alloc(65536));process.exit(1)\'',
        },
      }),
    );
    for (let index = 0; index < 3; index++)
      await assert.rejects(
        installUpstreamDependencies(root, "pin"),
        /Bun dependency install failed/,
      );
    const attempts = readdirSync(join(fixture, "cache/prepared/pin"))
      .filter((key) => !key.endsWith(".lock"))
      .flatMap((key) => {
        const path = join(fixture, "cache/prepared/pin", key, "attempts");
        return existsSync(path) ? readdirSync(path) : [];
      });
    assert.deepEqual(attempts, [], "failed preparations must not pile up behind expired groups");
  });

test("persistent current-boot uncertainty bounds failed preparations at three pending attempts per key", async (t) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "basalt-pending-limit-")));
  const previousPath = process.env.PATH,
    previousCache = process.env.BASALT_UPSTREAM_CACHE;
  const child = ownerProcess();
  t.after(() => {
    stop(child);
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previousCache;
    rmSync(fixture, { recursive: true, force: true });
  });
  await once(child, "message");
  const blocked = join(fixture, "cache/prepared/pin/blocked"),
    lease = join(blocked, "attempts/current-owner");
  mkdirSync(lease, { recursive: true });
  writeFileSync(join(blocked, "store-format.json"), JSON.stringify({ version: 3 }));
  writeFileSync(join(lease, "installer.json"), JSON.stringify({ group: child.pid }));
  const bin = join(fixture, "bin");
  failedEnumeration(bin);
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.BASALT_UPSTREAM_CACHE = join(fixture, "cache");
  const root = join(fixture, "consumer");
  mkdirSync(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "bounded-failure-fixture",
      scripts: {
        prepare:
          'node -e \'require("node:fs").writeFileSync("attempt-payload",Buffer.alloc(65536));process.exit(1)\'',
      },
    }),
  );
  const payloads = () =>
    readdirSync(join(fixture, "cache/prepared/pin"))
      .filter((key) => !key.endsWith(".lock"))
      .flatMap((key) => {
        const path = join(fixture, "cache/prepared/pin", key, "attempts");
        return existsSync(path)
          ? readdirSync(path)
              .map((id) => join(path, id, "attempt-payload"))
              .filter(existsSync)
          : [];
      });
  for (let index = 0; index < 3; index++) {
    await assert.rejects(installUpstreamDependencies(root, "pin"), /Bun dependency install failed/);
    assert.equal(payloads().length, index + 1);
  }
  for (let index = 0; index < 2; index++) {
    await assert.rejects(
      installUpstreamDependencies(root, "pin"),
      /limit of 3 pending dependency attempts/,
    );
    assert.equal(payloads().length, 3);
    assert.equal(
      payloads().reduce((bytes, path) => bytes + readFileSync(path).length, 0),
      3 * 65536,
    );
  }
  assert.equal(existsSync(lease), true, "an unverifiable live legacy group must remain protected");
  process.env.PATH = previousPath;
  await collectUpstreamDependencies();
  assert.deepEqual(payloads(), []);
  assert.equal(existsSync(lease), true);
  assert.equal(
    readFileSync(join(root, "package.json"), "utf8").includes("bounded-failure-fixture"),
    true,
  );
});
