import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const installer = new URL("../.github/actions/setup-browser/install-deps.sh", import.meta.url);
const timeout = ["timeout", "gtimeout"].flatMap((command) => {
  if (spawnSync(command, ["--version"]).status !== 0) return [];
  return [spawnSync("which", [command], { encoding: "utf8" }).stdout.trim()];
})[0];
assert.ok(timeout, "GNU timeout is required for the browser dependency deadline proof");

function fixture(mode = "success", url = "") {
  const root = mkdtempSync(join(tmpdir(), "browser-install-"));
  const script = join(root, ".github/actions/setup-browser/install-deps.sh");
  const bin = join(root, "bin");
  const receipt = join(root, "calls.jsonl");
  const apt = join(root, "etc/apt");
  for (const directory of [
    dirname(script),
    bin,
    join(root, ".upstream/node_modules/.bin"),
    join(apt, "apt.conf.d"),
    join(apt, "sources.list.d"),
    join(root, "tmp/playwright-apt"),
  ])
    mkdirSync(directory, { recursive: true });
  // Redirect only system paths so the real shell branches run without changing the host.
  writeFileSync(script, readFileSync(installer, "utf8").replaceAll("/etc/apt", apt));
  for (const path of ["sources.list.d/ubuntu.sources", "sources.list", "apt-mirrors.txt"])
    writeFileSync(join(apt, path), "http://azure.archive.ubuntu.com/ubuntu\n");
  writeFileSync(join(root, "tmp/playwright-apt/libfixture_1_amd64.deb"), "fixture");
  const mock = `#!${process.execPath}
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = ${JSON.stringify(root)};
const mode = ${JSON.stringify(mode)};
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
const record = (name, args) => appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({name, args, at: Date.now()}) + '\\n');
const execute = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
};
if (name === 'sudo') {
  record(name, args);
  if (args[0] === 'tee') {
    writeFileSync(args[1], readFileSync(0));
  } else if (args[0] === 'sed') {
    const [, pattern, replacement] = args[2].split('|');
    for (const path of args.slice(3)) {
      const destination = path;
      writeFileSync(destination, readFileSync(destination, 'utf8').replaceAll(pattern, replacement));
    }
  } else execute(args[0], args.slice(1));
} else if (name === 'bunx') {
  execute(join(root, '.upstream/node_modules/.bin/playwright'), args.slice(1));
} else if (name === 'dpkg') {
  record(name, args);
  if (mode === 'partial') process.exit(1);
  if (mode === 'slow') {
    const progress = setInterval(() => { record('unpack-progress', []); console.log('Unpacking fixture package...'); }, 5000);
    setTimeout(() => { clearInterval(progress); writeFileSync(join(root, 'installed'), 'yes'); }, 62000);
  } else writeFileSync(join(root, 'installed'), 'yes');
} else if (name === 'playwright') {
  const mirror = readFileSync(join(root, 'etc/apt/apt-mirrors.txt'), 'utf8').trim();
  record(name, [...args, mirror]);
  if (args.includes('--dry-run')) process.exit(mode !== 'missing' && existsSync(join(root, 'installed')) ? 0 : 1);
  const config = process.env.APT_CONFIG;
  if (config) {
    assert.equal(readFileSync(config, 'utf8').trim(), 'Binary::apt-get::APT::Get::Download-Only \"true\";');
    record('download-only', []);
  }
  if (mode === 'fail') process.exit(1);
  if (mode === 'stall' && mirror.includes('http://archive.ubuntu.com/'))
    execute('curl', ['--silent', '--show-error', '--max-time', '75', ${JSON.stringify(url)}]);
  if (!config) writeFileSync(join(root, 'installed'), 'yes');
} else throw new Error('Unexpected fixture command ' + name);
`;
  for (const name of ["sudo", "bunx", "dpkg"])
    writeFileSync(join(bin, name), mock, { mode: 0o755 });
  writeFileSync(join(root, ".upstream/node_modules/.bin/playwright"), mock, { mode: 0o755 });
  // macOS names GNU timeout gtimeout; the production runner names it timeout.
  writeFileSync(join(bin, "timeout"), `#!/bin/sh\nexec ${timeout} "$@"\n`, { mode: 0o755 });
  return {
    root,
    async run(hit: boolean) {
      const child = spawn("bash", [script, String(hit)], {
        env: {
          PATH: `${bin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
          RUNNER_TEMP: join(root, "tmp"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      return {
        code,
        output,
        calls: readFileSync(receipt, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { name: string; args: string[]; at: number }),
      };
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a restored package cache installs offline without an index refresh or mirror access", async () => {
  const fixture_ = fixture();
  try {
    const result = await fixture_.run(true);
    assert.equal(result.code, 0, result.output);
    assert.ok(
      !result.calls.some((call) => call.name === "playwright" && !call.args.includes("--dry-run")),
      "a cache hit must not invoke the network installer",
    );
    assert.ok(result.calls.some((call) => call.name === "dpkg"));
    assert.deepEqual(
      result.calls
        .filter((call) => call.name === "playwright")
        .map((call) => call.args.slice(0, 3)),
      [["install-deps", "--dry-run", "chromium"]],
    );
    assert.ok(!result.calls.some((call) => call.args[0] === "sed"));
    assert.ok(!result.calls.some((call) => call.name === "download-only"));
  } finally {
    fixture_.dispose();
  }
});

test("an incomplete cache fails offline without falling back to downloads", async () => {
  const fixture_ = fixture("partial");
  try {
    const result = await fixture_.run(true);
    assert.notEqual(result.code, 0);
    assert.ok(
      !result.calls.some((call) => call.name === "playwright" && !call.args.includes("--dry-run")),
    );
  } finally {
    fixture_.dispose();
  }
});

test("a missing dependency after cache installation fails without downloading", async () => {
  const fixture_ = fixture("missing");
  try {
    const result = await fixture_.run(true);
    assert.notEqual(result.code, 0);
    const calls = result.calls.filter((call) => call.name === "playwright");
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.args.includes("--dry-run"));
  } finally {
    fixture_.dispose();
  }
});

test("two failed mirrors exhaust the fixed attempt count", async () => {
  const fixture_ = fixture("fail");
  try {
    const result = await fixture_.run(false);
    assert.notEqual(result.code, 0);
    const attempts = result.calls.filter((call) => call.name === "playwright");
    assert.equal(attempts.length, 2);
    assert.equal(result.calls.filter((call) => call.name === "download-only").length, 2);
    assert.ok(!result.calls.some((call) => call.name === "dpkg"));
    assert.ok(attempts[0]!.args.at(-1)!.includes("http://archive.ubuntu.com/"));
    assert.ok(attempts[1]!.args.at(-1)!.includes("http://azure.archive.ubuntu.com/"));
    assert.equal(
      result.calls.filter((call) => call.name === "sudo" && call.args[0] === "timeout").length,
      2,
    );
  } finally {
    fixture_.dispose();
  }
});

for (const hit of [true, false]) {
  test(`a progressing local install can exceed the mirror deadline after a cache ${hit ? "hit" : "miss"}`, async () => {
    const fixture_ = fixture("slow");
    try {
      const start = Date.now();
      const result = await fixture_.run(hit);
      const seconds = (Date.now() - start) / 1000;
      assert.equal(result.code, 0, result.output);
      assert.ok(seconds >= 62, `local installation ended after ${seconds}s`);
      assert.ok(result.calls.filter((call) => call.name === "unpack-progress").length >= 12);
      assert.ok(result.calls.some((call) => call.name === "dpkg"));
      assert.equal(
        result.calls.filter((call) => call.name === "download-only").length,
        hit ? 0 : 1,
      );
      console.log(
        `Progressing local install after cache ${hit ? "hit" : "miss"} completed in ${seconds.toFixed(2)}s`,
      );
    } finally {
      fixture_.dispose();
    }
  });
}

test("a mirror that accepts connections but never responds reaches the fallback within 70 seconds", async () => {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const fixture_ = fixture("stall", `http://127.0.0.1:${address.port}/`);
  try {
    const start = Date.now();
    const result = await fixture_.run(false);
    const seconds = (Date.now() - start) / 1000;
    assert.equal(result.code, 0, result.output);
    const attempts = result.calls.filter((call) => call.name === "playwright");
    assert.equal(attempts.length, 2);
    assert.ok(seconds >= 59 && seconds < 70, `mirror failover took ${seconds}s`);
    console.log(`Stalled mirror failed over and installed in ${seconds.toFixed(2)}s`);
  } finally {
    fixture_.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
