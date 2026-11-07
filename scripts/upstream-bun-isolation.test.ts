import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { dependencyInstallBackend } from "./upstream-inputs.ts";
import { fixturePhases } from "./upstream-fixture-phases.ts";
import { fixtureInventory } from "./upstream-fixture-inventory.ts";
import { fixtureGate } from "./upstream-fixture-gate.ts";

test(
  "real Bun cache hardlinks cannot carry an orphan's writes into a published generation",
  { timeout: 15000 },
  async (t) => {
    const phase = fixturePhases(t, "upstream-bun-isolation");
    const fixture = mkdtempSync(join(tmpdir(), "basalt-476-hardlink-"));
    const realBun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    const inventory = fixtureInventory(t, fixture);
    const bin = join(fixture, "bin");
    const template = join(fixture, "template");
    mkdirSync(bin);
    mkdirSync(template);
    const lifecycle = join(fixture, "lifecycle.mjs");
    const gate = await fixtureGate(t);
    const owned = new Set<number>();
    t.after(() => {
      for (const pid of owned) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        }
      }
      const writable = (path: string) => {
        chmodSync(path, 0o755);
        for (const e of readdirSync(path, { withFileTypes: true }))
          if (e.isDirectory()) writable(join(path, e.name));
      };
      writable(fixture);
      rmSync(fixture, { recursive: true, force: true });
    });
    writeFileSync(
      lifecycle,
      `
import { openSync, writeSync, closeSync, realpathSync, statSync } from 'node:fs';
import { waitForFixtureRelease } from ${JSON.stringify(new URL("./upstream-fixture-gate.ts", import.meta.url).href)};
const path = realpathSync('node_modules/is-number/index.js');
if (process.env.FIXTURE_MODE === 'orphan') {
  const fd = openSync(path, 'r+');
  const released = waitForFixtureRelease(process.env.FIXTURE_GATE_PORT);
  console.log(JSON.stringify({type:'held', pid:process.pid, bunPid:process.ppid, path, inode:statSync(path).ino}));
  await released;
  writeSync(fd, Buffer.from('ORPHAN-WROTE-THIS'), 0, 17, 0);
  closeSync(fd);
  console.log(JSON.stringify({type:'orphan-finished'}));
}
`,
    );
    writeFileSync(
      join(template, "package.json"),
      JSON.stringify({
        name: "hardlink-fixture",
        scripts: { prepare: `node ${lifecycle}` },
        dependencies: { "is-number": "7.0.0" },
      }),
    );
    writeFileSync(join(template, "bunfig.toml"), '[install]\nlinker = "isolated"\n');
    const common = {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: join(fixture, "bun-cache"),
      BASALT_UPSTREAM_CACHE: join(fixture, "cache"),
      FIXTURE_GATE_PORT: gate.port,
    };
    phase.waiting("template-installed");
    execFileSync(realBun, ["install", "--ignore-scripts", "--backend=hardlink"], {
      cwd: template,
      env: common,
      stdio: "pipe",
    });
    phase.reached("template-installed");
    // --version must remain a version request, without install-only flags.
    writeFileSync(
      join(bin, "bun"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then exec '${realBun}' --version; fi\nexec '${realBun}' --backend=hardlink "$@"\n`,
    );
    chmodSync(join(bin, "bun"), 0o755);
    function start(name: string) {
      const root = join(fixture, name);
      mkdirSync(root);
      inventory.checkout(root);
      for (const file of ["package.json", "bunfig.toml", "bun.lock"])
        cpSync(join(template, file), join(root, file));
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
    import { installUpstreamDependencies } from ${JSON.stringify(new URL("./upstream-dependencies.ts", import.meta.url).href)};
    const prepared = await installUpstreamDependencies(${JSON.stringify(root)}, 'fixture-pin');
    console.log(JSON.stringify({type:'published', ...prepared}));
  `,
        ],
        {
          env: { ...common, PATH: `${bin}:${process.env.PATH}`, FIXTURE_MODE: name },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      owned.add(child.pid!);
      inventory.track(child.pid!);
      child.on("exit", () => owned.delete(child.pid!));
      let errors = "";
      child.stderr!.on("data", (data) => {
        errors += data;
      });
      const queued: Record<string, unknown>[] = [],
        waiting: { type: string; resolve: (value: Record<string, unknown>) => void }[] = [];
      createInterface({ input: child.stdout! }).on("line", (line) => {
        if (!line.startsWith('{"type":')) return;
        const message = JSON.parse(line);
        if (message.type === "held") {
          owned.add(Number(message.pid));
          owned.add(Number(message.bunPid));
          inventory.track(Number(message.pid));
          inventory.track(Number(message.bunPid));
        }
        const index = waiting.findIndex((w) => w.type === message.type);
        if (index < 0) queued.push(message);
        else waiting.splice(index, 1)[0]!.resolve(message);
      });
      return {
        child,
        root,
        next(type: string) {
          const index = queued.findIndex((m) => m.type === type);
          if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!);
          return new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`Waiting for ${type}: ${errors}`)),
              12000,
            );
            waiting.push({
              type,
              resolve(value) {
                clearTimeout(timer);
                resolve(value);
              },
            });
          });
        },
      };
    }
    const first = start("orphan");
    phase.waiting("held");
    const held = await first.next("held");
    phase.reached("held");
    assert.ok(
      execFileSync("lsof", ["-nP", "-F0n"], { encoding: "utf8" }).includes(`n${held.path}\0`),
      "the real orphan descriptor must remain visible to fixture collection",
    );
    const stopped = once(first.child, "exit");
    first.child.kill("SIGKILL");
    phase.waiting("parent-exit");
    await stopped;
    phase.reached("parent-exit");
    const second = start("replacement");
    phase.waiting("replacement-published");
    const published = await second.next("published");
    phase.reached("replacement-published");
    phase.waiting("replacement-exit");
    if (second.child.exitCode === null) await once(second.child, "exit");
    phase.reached("replacement-exit");
    const packageFile = join(String(published.store), "node_modules/is-number/index.js");
    const before = readFileSync(packageFile, "utf8");
    const state = statSync(packageFile);

    await gate.release();
    phase.waiting("orphan-finished");
    await first.next("orphan-finished");
    phase.reached("orphan-finished");
    phase.waiting("published-bytes-verified");
    const after = readFileSync(packageFile, "utf8");
    assert.notEqual(state.ino, held.inode, "private installs must not share package inodes");
    assert.equal(after, before, "the orphan must not change published bytes");
    console.log(
      JSON.stringify(
        {
          realBun: execFileSync(realBun, ["--version"], { encoding: "utf8" }).trim(),
          defaultBackend: "hardlink",
          installBackend: dependencyInstallBackend,
          distinctAttemptAndGenerationPaths: held.path !== packageFile,
          sharedInode: state.ino === held.inode,
          linkCount: state.nlink,
          publishedFileMode: (state.mode & 0o777).toString(8),
          publishedFileChangedAfterOrphanRelease: after !== before,
          prefixAfterOrphanRelease: after.slice(0, 17),
        },
        null,
        2,
      ),
    );
    phase.reached("published-bytes-verified");
    phase.complete();
  },
);
