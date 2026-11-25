import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("./ci/unit-tests.ts", import.meta.url));
const reporter = fileURLToPath(new URL("./ci/unit-progress.ts", import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "unit-deadline-"));
  mkdirSync(join(root, "scripts"));
  return root;
}

async function run(root: string, args: string[], onOutput?: (output: string) => void) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined,
      BASE_SHA: "",
      HEAD_SHA: "",
      // A unit leg runs this test; the fixture suite is not that leg's share.
      UNIT_SHARD: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const receive = (data: Buffer) => {
    output += data;
    onOutput?.(output);
  };
  child.stdout.on("data", receive);
  child.stderr.on("data", receive);
  let expired = false;
  const watchdog = setTimeout(() => {
    expired = true;
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  }, 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, expired, output };
  } finally {
    clearTimeout(watchdog);
  }
}

for (const lane of ["full", "focused"]) {
  test(`${lane} owned tests enforce the manifest deadline and name the stalled test`, async () => {
    const root = fixture();
    const options = ["--test", "--test-timeout=100", `--test-reporter=${reporter}`];
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { check: `node ${options.join(" ")} scripts/*.test.mjs` } }),
    );
    writeFileSync(
      join(root, "scripts/stuck.test.mjs"),
      `import { test } from 'node:test';
test('synthetic never resolving test', async (t) => {
  const keepAlive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keepAlive));
  await new Promise(() => {});
});\n`,
    );
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    try {
      const result = await run(
        root,
        lane === "full" ? [...options, "scripts/stuck.test.mjs"] : [runner],
      );
      assert.equal(result.expired, false, result.output);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /test timed out after 100ms/);
      const events = result.output
        .split("\n")
        .filter((line) => line.startsWith("OWNED_TEST "))
        .map((line) => JSON.parse(line.slice(11)));
      assert.ok(
        events.some(
          (event) =>
            event.phase === "start" &&
            event.name === "synthetic never resolving test" &&
            event.file === "scripts/stuck.test.mjs" &&
            event.line === 2,
        ),
      );
      assert.ok(
        events.some(
          (event) =>
            event.phase === "complete" &&
            event.name === "synthetic never resolving test" &&
            event.passed === false,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("owned progress reports a later file completing before an earlier file finishes", async () => {
  const root = fixture();
  writeFileSync(
    join(root, "scripts/first.test.mjs"),
    `import { test } from 'node:test';
import { watch, existsSync } from 'node:fs';
test('held first', async (t) => {
  await new Promise(resolve => {
    const watcher = watch('.', () => { if (existsSync('release')) resolve(); });
    t.after(() => watcher.close());
    if (existsSync('release')) resolve();
  });
});\n`,
  );
  writeFileSync(
    join(root, "scripts/second.test.mjs"),
    "import { test } from 'node:test'; test('ready second', () => {});\n",
  );
  try {
    const result = await run(
      root,
      [
        "--test",
        "--test-concurrency=2",
        "--test-timeout=2000",
        `--test-reporter=${reporter}`,
        "scripts/first.test.mjs",
        "scripts/second.test.mjs",
      ],
      (output) => {
        if (/OWNED_TEST \{"phase":"complete"[^\n]*"name":"ready second"/.test(output))
          writeFileSync(join(root, "release"), "ready");
      },
    );
    assert.equal(result.code, 0, result.output);
    const completed = result.output
      .split("\n")
      .filter((line) => line.startsWith("OWNED_TEST "))
      .map((line) => JSON.parse(line.slice(11)))
      .filter((event) => event.phase === "complete")
      .map((event) => event.name);
    assert.ok(completed.indexOf("ready second") >= 0, result.output);
    assert.ok(completed.indexOf("ready second") < completed.indexOf("held first"), result.output);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
