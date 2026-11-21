import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, BASE_SHA: "", HEAD_SHA: "" },
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

test("shards of the owned suite run every test file once between them", async () => {
  const root = fixture();
  try {
    const options = ["--test", "--test-timeout=5000", `--test-reporter=${reporter}`];
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { check: `node ${options.join(" ")} scripts/*.test.mjs` } }),
    );
    const files = Array.from({ length: 7 }, (_, index) => `t${index}`);
    for (const name of files)
      writeFileSync(
        join(root, `scripts/${name}.test.mjs`),
        `import { appendFileSync } from 'node:fs';
import { test } from 'node:test';
test('${name}', () => appendFileSync(${JSON.stringify(join(root, "ran.log"))}, '${name}\\n'));
`,
      );
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    const ran = () =>
      execFileSync("cat", [join(root, "ran.log")], { encoding: "utf8" })
        .trim()
        .split("\n");
    const counts = new Map<string, number>();
    for (const shard of ["1/3", "2/3", "3/3"]) {
      rmSync(join(root, "ran.log"), { force: true });
      const result = await run(root, [runner, `--shard=${shard}`]);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, new RegExp(`shard ${shard} of 7 files`));
      for (const name of ran()) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    assert.deepEqual([...counts.keys()].sort(), files);
    assert.ok(
      [...counts.values()].every((count) => count === 1),
      JSON.stringify([...counts]),
    );
    for (const shard of ["0/3", "4/3", "x", "1/0", "2"]) {
      const refused = await run(root, [runner, `--shard=${shard}`]);
      assert.notEqual(refused.code, 0, shard);
      assert.match(refused.output, /Expected a shard like --shard=2\/3/, shard);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a full suite runs the complete owned suite in owned-units' legs, and fast runs it no more", () => {
  const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const job = workflow.jobs["owned-units"];
  const legs: number[] = job.strategy.matrix.shard;
  assert.deepEqual(
    legs,
    Array.from({ length: legs.length }, (_, index) => index + 1),
  );
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job.if, "needs.select.outputs.full_suite == 'true'");
  const run = job.steps.map((step: { run?: string }) => step.run).filter(Boolean);
  assert.deepEqual(run, [
    "npm run prepare:upstream",
    `node scripts/ci/unit-tests.ts --shard=\${{ matrix.shard }}/${legs.length}`,
  ]);
  assert.ok(workflow.jobs.check.needs.includes("owned-units"));
  // fast keeps the focused owned tests for a pull request, and no longer runs the whole suite.
  const fast = workflow.jobs.fast.steps.map((step: { run?: string }) => step.run ?? "");
  assert.ok(!fast.some((command: string) => /(^|\n)\s*npm run check\s*($|\n)/.test(command)));
  assert.ok(fast.includes("node scripts/ci/unit-tests.ts"));
});
