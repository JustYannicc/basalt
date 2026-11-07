import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { fixturePhases } from "./upstream-fixture-phases.ts";
import { fixtureInventory } from "./upstream-fixture-inventory.ts";

const stop = (child: ReturnType<typeof spawn>) => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};

test(
  "collection waits for a live PID-only reader to register its selected generation",
  { timeout: 5000 },
  async (t) => {
    const phase = fixturePhases(t, "upstream-legacy-reader");
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "basalt-legacy-reader-")));
    const inventory = fixtureInventory(t, fixture);
    const cache = join(fixture, "cache");
    const root = join(fixture, "reader");
    const entry = join(cache, "prepared/pin/key");
    const generation = join(entry, "generations/selected");
    mkdirSync(generation, { recursive: true });
    mkdirSync(root);
    inventory.checkout(root);
    writeFileSync(join(entry, "store-format.json"), JSON.stringify({ version: 3 }));
    writeFileSync(join(generation, "package-bytes"), "selected package");
    const reader = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {readFileSync,writeFileSync,symlinkSync,unlinkSync,mkdirSync} from 'node:fs';
    const cache=${JSON.stringify(cache)}, root=${JSON.stringify(root)}, store=${JSON.stringify(generation)};
    symlinkSync(JSON.stringify({pid:process.pid,id:'legacy-reader'}), cache+'/collection.lock');
    const selected=readFileSync(store+'/package-bytes','utf8');
    process.on('message', () => {
      mkdirSync(cache+'/consumers',{recursive:true});
      writeFileSync(root+'/.basalt-dependencies.json',JSON.stringify({store}));
      writeFileSync(cache+'/consumers/legacy.json',JSON.stringify({root,stores:[store],pending:false}));
      unlinkSync(cache+'/collection.lock');
      process.send({stage:'registered',value:readFileSync(store+'/package-bytes','utf8')},()=>process.exit(0));
    });
    process.send({stage:'selected',value:selected});
  `,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    inventory.track(reader.pid!);
    let collector: ReturnType<typeof spawn> | undefined;
    t.after(() => {
      stop(reader);
      if (collector) stop(collector);
      rmSync(fixture, { recursive: true, force: true });
    });
    phase.waiting("selected");
    assert.equal((await once(reader, "message"))[0].stage, "selected");
    phase.reached("selected");
    collector = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {collectUpstreamDependencies} from ${JSON.stringify(new URL("./upstream-store.ts", import.meta.url).href)};
    const kill=process.kill.bind(process);let sent=false;
    process.kill=(pid,signal)=>{
      const result=kill(pid,signal);
      if(pid===${reader.pid} && signal===0 && !sent){sent=true;process.send({stage:'legacy-owner-alive'});}
      return result;
    };
    await collectUpstreamDependencies();
    process.send({stage:'collected'},()=>process.exit(0));
  `,
      ],
      {
        env: { ...process.env, BASALT_UPSTREAM_CACHE: cache },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    inventory.track(collector.pid!);
    phase.waiting("legacy-owner-alive");
    assert.equal((await once(collector, "message"))[0].stage, "legacy-owner-alive");
    phase.reached("legacy-owner-alive");
    assert.equal(existsSync(generation), true, "the selected unregistered generation must survive");
    const registered = once(reader, "message"),
      collected = once(collector, "message");
    reader.send("register");
    phase.waiting("registration-and-lock-removal");
    assert.deepEqual((await registered)[0], { stage: "registered", value: "selected package" });
    phase.reached("registration-and-lock-removal");
    phase.waiting("collected");
    assert.equal((await collected)[0].stage, "collected");
    phase.reached("collected");
    phase.waiting("collector-exit");
    if (collector.exitCode === null) await once(collector, "exit");
    phase.reached("collector-exit");
    assert.equal(collector.exitCode, 0);
    assert.equal(readFileSync(join(generation, "package-bytes"), "utf8"), "selected package");
    phase.complete();
  },
);

test("live PID-only parent and group leases remain protected until their owner exits", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "basalt-legacy-leases-"));
  const inventory = fixtureInventory(t, fixture);
  const previous = process.env.BASALT_UPSTREAM_CACHE;
  const owner = spawn(
    process.execPath,
    ["-e", "process.on('message',()=>process.exit(0));process.send('ready');"],
    { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  inventory.track(owner.pid!);
  t.after(() => {
    stop(owner);
    if (previous === undefined) delete process.env.BASALT_UPSTREAM_CACHE;
    else process.env.BASALT_UPSTREAM_CACHE = previous;
    rmSync(fixture, { recursive: true, force: true });
  });
  await once(owner, "message");
  process.env.BASALT_UPSTREAM_CACHE = join(fixture, "cache");
  const entry = join(process.env.BASALT_UPSTREAM_CACHE, "prepared/pin/key");
  const parent = join(entry, "attempts/parent"),
    group = join(entry, "attempts/group");
  mkdirSync(parent, { recursive: true });
  mkdirSync(group, { recursive: true });
  writeFileSync(join(entry, "store-format.json"), JSON.stringify({ version: 3 }));
  writeFileSync(join(parent, "parent.json"), JSON.stringify({ pid: owner.pid }));
  writeFileSync(join(group, "installer.json"), JSON.stringify({ group: owner.pid }));
  await collectUpstreamDependencies();
  assert.equal(existsSync(parent), true);
  assert.equal(existsSync(group), true);
  const exited = once(owner, "exit");
  owner.send("exit");
  await exited;
  await collectUpstreamDependencies();
  assert.equal(existsSync(parent), false);
  assert.equal(existsSync(group), false);
});
