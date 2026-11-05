import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectUpstreamDependencies } from "./upstream-store.ts";
import { readProcessOwner } from "./process-owner.ts";

for (const failure of ["libproc-zero", "child-environment-unavailable"])
  test(
    `${failure} never permits collection of a genuine orphan or other cache data`,
    { skip: process.platform !== "darwin" },
    async (t) => {
      const fixture = realpathSync(mkdtempSync(join(tmpdir(), "basalt-snapshot-safety-")));
      const realBun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
      const realPs = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
      const previousPath = process.env.PATH,
        previousCache = process.env.BASALT_UPSTREAM_CACHE;
      let orphan: number | undefined;
      const token = "genuine-installer-incarnation";
      const leader = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
    import {spawn} from 'node:child_process';import {once} from 'node:events';
    import {currentProcessOwner} from ${JSON.stringify(new URL("./process-owner.ts", import.meta.url).href)};
    const owner=currentProcessOwner();
    const child=spawn(process.execPath,['-e',"setInterval(()=>{},60000);process.send('ready');"],{stdio:['ignore','inherit','inherit','ipc']});
    await once(child,'message');process.send({owner,pid:child.pid},()=>process.exit(0));
  `,
        ],
        {
          detached: true,
          env: { ...process.env, BASALT_DEPENDENCY_INSTALLER: token },
          stdio: ["ignore", "pipe", "inherit", "ipc"],
        },
      );
      t.after(() => {
        if (leader.exitCode === null && leader.signalCode === null) leader.kill("SIGKILL");
        if (orphan)
          try {
            process.kill(orphan, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        process.env.PATH = previousPath;
        if (previousCache === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
        else process.env.BASALT_UPSTREAM_CACHE = previousCache;
        rmSync(fixture, { recursive: true, force: true });
      });
      const [{ owner, pid }] = await once(leader, "message");
      orphan = pid;
      if (leader.exitCode === null) await once(leader, "exit");
      process.env.BASALT_UPSTREAM_CACHE = join(fixture, "cache");
      const entry = join(process.env.BASALT_UPSTREAM_CACHE, "prepared/pin/key");
      const attempt = join(entry, "attempts/genuine-orphan"),
        abandoned = join(entry, "attempts/abandoned"),
        generation = join(entry, "generations/unreferenced");
      mkdirSync(attempt, { recursive: true });
      writeFileSync(join(entry, "store-format.json"), JSON.stringify({ version: 3 }));
      writeFileSync(
        join(attempt, "installer.json"),
        JSON.stringify({ ...owner, group: owner.pid, token }),
      );
      await collectUpstreamDependencies();
      assert.equal(existsSync(attempt), true);
      mkdirSync(abandoned);
      mkdirSync(generation, { recursive: true });
      const bin = join(fixture, "bin");
      mkdirSync(bin);
      if (failure === "libproc-zero") {
        const source = readFileSync(new URL("./process-owner-darwin.mjs", import.meta.url), "utf8");
        const call = "symbols.proc_pidinfo(pid, 3, 0, ptr(buffer), buffer.length)";
        assert.equal(source.split(call).length, 2);
        const altered = join(fixture, "incomplete-process-owner.mjs");
        writeFileSync(altered, source.replace(call, `pid === ${pid} ? 0 : ${call}`));
        writeFileSync(
          join(bin, "bun"),
          `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');\nlet args=process.argv.slice(2);\nif(args[0]?.endsWith('process-owner-darwin.mjs') && (args.length===1 || args[1]==='--groups')) args[0]=${JSON.stringify(altered)};\nconst result=spawnSync(${JSON.stringify(realBun)},args,{stdio:'inherit'});process.exit(result.status??1);\n`,
          { mode: 0o755 },
        );
      } else {
        writeFileSync(
          join(bin, "ps"),
          `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');\nif(process.argv[2]==='eww')process.exit(1);\nconst result=spawnSync(${JSON.stringify(realPs)},process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);\n`,
          { mode: 0o755 },
        );
      }
      process.env.PATH = `${bin}:${previousPath}`;
      await collectUpstreamDependencies();
      assert.equal(existsSync(attempt), true, "a missed live child cannot authorize removal");
      assert.equal(
        existsSync(abandoned),
        true,
        "the whole incomplete collection pass must be skipped",
      );
      assert.equal(
        existsSync(generation),
        true,
        "no generations may be collected from an incomplete snapshot",
      );
      assert.ok(readProcessOwner(pid), "targeted libproc still sees the genuine child");
      process.env.PATH = previousPath;
      await collectUpstreamDependencies();
      assert.equal(existsSync(attempt), true);
      assert.equal(existsSync(abandoned), false);
      assert.equal(existsSync(generation), false);
    },
  );

test("failed process enumeration skips every deletion and a later complete pass collects", async (t) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "basalt-enumeration-failure-")));
  const previousPath = process.env.PATH,
    previousCache = process.env.BASALT_UPSTREAM_CACHE;
  const realPs = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
  const holder = spawn(
    process.execPath,
    ["-e", "process.on('message',()=>process.exit(0));process.send('ready');"],
    { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  t.after(() => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    process.env.PATH = previousPath;
    if (previousCache === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previousCache;
    rmSync(fixture, { recursive: true, force: true });
  });
  process.env.BASALT_UPSTREAM_CACHE = join(fixture, "cache");
  await collectUpstreamDependencies();
  const entry = join(process.env.BASALT_UPSTREAM_CACHE, "prepared/pin/key");
  const attempt = join(entry, "attempts/abandoned"),
    generation = join(entry, "generations/unreferenced");
  mkdirSync(attempt, { recursive: true });
  mkdirSync(generation, { recursive: true });
  writeFileSync(join(entry, "store-format.json"), JSON.stringify({ version: 3 }));
  await once(holder, "message");
  const currentOwner = join(entry, "attempts/current-owner");
  mkdirSync(currentOwner);
  writeFileSync(join(currentOwner, "installer.json"), JSON.stringify({ group: holder.pid }));
  const bin = join(fixture, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "ps"),
    `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');\nif(process.argv[2]==='-axo'||process.argv[2]==='-eo')process.exit(1);\nconst result=spawnSync(${JSON.stringify(realPs)},process.argv.slice(2),{stdio:'inherit'});process.exit(result.status??1);\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${previousPath}`;
  await collectUpstreamDependencies();
  assert.equal(existsSync(attempt), true);
  assert.equal(existsSync(generation), true);
  process.env.PATH = previousPath;
  await collectUpstreamDependencies();
  assert.equal(existsSync(attempt), false);
  assert.equal(existsSync(generation), false);
  assert.equal(existsSync(currentOwner), true, "a live legacy group remains protected");
});
