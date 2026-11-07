import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fixturePhases } from "./upstream-fixture-phases.ts";
import { fixtureInventory } from "./upstream-fixture-inventory.ts";

function output(child: ReturnType<typeof spawn>) {
  const messages: Record<string, unknown>[] = [];
  const waiting: { type: string; resolve: (message: Record<string, unknown>) => void }[] = [];
  const lines = createInterface({ input: child.stdout! });
  lines.on("line", (line) => {
    if (!line.startsWith('{"type":')) return;
    const message = JSON.parse(line) as Record<string, unknown>;
    const index = waiting.findIndex((entry) => entry.type === message.type);
    if (index < 0) messages.push(message);
    else waiting.splice(index, 1)[0]!.resolve(message);
  });
  return (type: string) => {
    const index = messages.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
    return new Promise<Record<string, unknown>>((resolve) => waiting.push({ type, resolve }));
  };
}

test(
  "an installer surviving its parent cannot overwrite a newly published generation",
  { timeout: 15_000 },
  async (t) => {
    const phase = fixturePhases(t, "upstream-install-recovery");
    const directory = mkdtempSync(join(tmpdir(), "basalt-orphan-install-"));
    const inventory = fixtureInventory(t, directory);
    const processes: number[] = [];
    t.after(() => {
      for (const pid of processes) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      // The test owns these installed files, including the immutable generations.
      const makeWritable = (path: string) => {
        chmodSync(path, 0o755);
        for (const entry of readdirSync(path, { withFileTypes: true }))
          if (entry.isDirectory()) makeWritable(join(path, entry.name));
      };
      makeWritable(directory);
      rmSync(directory, { recursive: true, force: true });
    });
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const installer = join(bin, "bun");
    const realBun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    writeFileSync(
      installer,
      `#!/usr/bin/env node
import { mkdirSync, writeFileSync, symlinkSync, existsSync, watch, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
if (process.argv[2]?.endsWith("process-owner-darwin.mjs")) {
  const result = spawnSync(process.env.FIXTURE_REAL_BUN, process.argv.slice(2), {stdio:"inherit"});
  process.exit(result.status ?? 1);
}
if (process.argv[2] === "--version") { console.log("1.4.2"); process.exit(0); }
const directory = process.cwd();
const name = process.env.FIXTURE_INSTALLER;
let released;
if (name === "orphan") released = new Promise(resolve => {
  const gate = process.env.FIXTURE_GATE;
  const watcher = watch(dirname(gate), () => {
    if (existsSync(gate)) { watcher.close(); resolve(); }
  });
});
console.log(JSON.stringify({type:"install-started",pid:process.pid,directory,name}));
if (released) await released;
const packages = join(directory, "node_modules/.bun/fixture-package@1/node_modules/fixture-package");
mkdirSync(packages, {recursive:true});
if (existsSync(join(packages, "index.js"))) chmodSync(join(packages, "index.js"), 0o644);
writeFileSync(join(packages, "index.js"), name);
const link = join(directory, "node_modules/fixture-package");
if (!existsSync(link)) symlinkSync(".bun/fixture-package@1/node_modules/fixture-package", link);
console.log(JSON.stringify({type:"install-finished",name}));
`,
    );
    chmodSync(installer, 0o755);
    const root = (name: string) => {
      const path = join(directory, name);
      mkdirSync(path);
      inventory.checkout(path);
      writeFileSync(
        join(path, "package.json"),
        JSON.stringify({ name: "fixture", dependencies: { "fixture-package": "1.0.0" } }),
      );
      writeFileSync(join(path, "bun.lock"), "fixture-lock");
      return path;
    };
    const prepare = (name: string) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import { installUpstreamDependencies } from ${JSON.stringify(new URL("./upstream-dependencies.ts", import.meta.url).href)};
      const result = await installUpstreamDependencies(${JSON.stringify(root(name))}, "fixture-pin");
      console.log(JSON.stringify({type:"prepared",...result}));
    `,
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            BASALT_UPSTREAM_CACHE: join(directory, "cache"),
            FIXTURE_INSTALLER: name,
            FIXTURE_GATE: join(directory, "release-orphan"),
            FIXTURE_REAL_BUN: realBun,
          },
          stdio: ["ignore", "pipe", "inherit"],
        },
      );
      processes.push(child.pid!);
      inventory.track(child.pid!);
      return { child, next: output(child) };
    };
    const first = prepare("orphan");
    const orphanClosed = once(first.child.stdout!, "end");
    phase.waiting("install-started");
    const orphan = await first.next("install-started");
    phase.reached("install-started");
    processes.push(Number(orphan.pid));
    inventory.track(Number(orphan.pid));
    const stopped = once(first.child, "exit");
    first.child.kill("SIGKILL");
    phase.waiting("parent-exit");
    await stopped;
    phase.reached("parent-exit");
    phase.waiting("installer-lease");
    const lease = JSON.parse(
      readFileSync(join(String(orphan.directory), "installer.json"), "utf8"),
    );
    phase.reached("installer-lease");
    const installerPid = Number(lease.pid ?? lease.group);
    processes.push(installerPid);
    inventory.track(installerPid);
    process.kill(installerPid, "SIGKILL");
    const second = prepare("replacement");
    phase.waiting("replacement-install-started");
    const replacement = await second.next("install-started");
    inventory.track(Number(replacement.pid));
    phase.reached("replacement-install-started");
    phase.waiting("prepared");
    const published = await second.next("prepared");
    phase.reached("prepared");
    assert.equal(
      existsSync(String(orphan.directory)),
      true,
      "a surviving installer keeps its attempt",
    );
    const secondExit =
      second.child.exitCode === null ? once(second.child, "exit") : Promise.resolve();
    phase.waiting("replacement-exit");
    await secondExit;
    phase.reached("replacement-exit");
    writeFileSync(join(directory, "release-orphan"), "release");
    phase.waiting("install-finished");
    await first.next("install-finished");
    phase.reached("install-finished");
    phase.waiting("orphan-eof");
    await orphanClosed;
    phase.reached("orphan-eof");
    phase.waiting("collected");
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { collectUpstreamDependencies } from ${JSON.stringify(new URL("./upstream-store.ts", import.meta.url).href)};
      await collectUpstreamDependencies();
    `,
      ],
      { env: { ...process.env, BASALT_UPSTREAM_CACHE: join(directory, "cache") } },
    );
    phase.reached("collected");
    phase.waiting("replacement-bytes-verified");
    assert.equal(
      existsSync(String(orphan.directory)),
      false,
      "the abandoned attempt is collected after its installer exits",
    );
    const packageFile = join(
      String(published.store),
      "node_modules/.bun/fixture-package@1/node_modules/fixture-package/index.js",
    );
    assert.equal(readFileSync(packageFile, "utf8"), "replacement");
    assert.notEqual(orphan.directory, replacement.directory);
    phase.reached("replacement-bytes-verified");
    phase.complete();
  },
);
