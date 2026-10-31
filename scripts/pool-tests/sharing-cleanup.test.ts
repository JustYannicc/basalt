import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function run(input: { running?: boolean; failedList?: boolean; prebuilt?: boolean; exit?: boolean; unstarted?: boolean; twice?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "basalt-cleanup-"));
  try {
    const log = join(directory, "calls.jsonl");
    const executable = join(directory, "docker");
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_DOCKER_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "network" && args[1] === "create") { console.error("Synthetic network start failure"); process.exit(1); }
if (args[0] === "ps") {
  if (process.env.FIXTURE_DOCKER_LIST_FAIL === "1") process.exit(1);
  if (process.env.FIXTURE_DOCKER_RUNNING === "1") process.stdout.write("unrelated-container\\n");
}
`);
    chmodSync(executable, 0o755);
    const fixture = new URL("./sharing-fixture.ts", import.meta.url).href;
    const source = `import { SharingFixture } from ${JSON.stringify(fixture)};
delete process.env.POOL_TEST_IMAGE;
const fixture = new SharingFixture(${input.prebuilt ? '{ image: "external-shared:test" }' : '{}'});
${input.unstarted ? '' : 'try { await fixture.start(); throw new Error("Expected synthetic network failure"); } catch (error) { if (!String(error).includes("Synthetic network start failure")) throw error; }'}
${input.exit ? 'process.exit(0);' : `await fixture.close();${input.twice ? ' await fixture.close();' : ''}`}
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8", timeout: 15_000,
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`,
        FIXTURE_DOCKER_LOG: log, FIXTURE_DOCKER_RUNNING: input.running ? "1" : "0",
        FIXTURE_DOCKER_LIST_FAIL: input.failedList ? "1" : "0" },
    });
    const calls: string[][] = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    return { status: result.status, output: result.stderr + result.stdout, calls };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function assertBuiltImageRemoved(calls: string[][]) {
  const build = calls.find((call) => call[0] === "build")!;
  const image = build[build.indexOf("--tag") + 1]!;
  assert.deepEqual(calls.find((call) => call[0] === "image" && call[1] === "rm"), ["image", "rm", image]);
  assert.equal(calls.filter((call) => call[0] === "builder").length, 1);
  assert.deepEqual(calls.at(-1), ["builder", "prune", "-f"]);
  assert.ok(calls.findIndex((call) => call[0] === "ps") < calls.findIndex((call) => call[0] === "image"));
}

test("a failed fixture start removes its own image and prunes builder cache in finally", () => {
  const result = run();
  assert.equal(result.status, 0, result.output);
  assertBuiltImageRemoved(result.calls);
});

test("process exit removes a built fixture image and builder cache without a normal close", () => {
  const result = run({ exit: true });
  assert.equal(result.status, 0, result.output);
  assertBuiltImageRemoved(result.calls);
});

test("another running container vetoes both image removal and builder pruning", () => {
  const result = run({ running: true });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls.at(-1), ["ps", "--quiet"]);
  assert.equal(result.calls.some((call) => call[0] === "image" || call[0] === "builder"), false);
});

test("an unreadable running-container list vetoes image and builder cleanup and reports failure", () => {
  const result = run({ failedList: true });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Fixture cleanup failed/);
  assert.equal(result.calls.some((call) => call[0] === "image" || call[0] === "builder"), false);
});

test("a supplied shared image survives cleanup while idle builder cache is pruned", () => {
  const result = run({ prebuilt: true });
  assert.equal(result.status, 0, result.output);
  assert.equal(result.calls.some((call) => call[0] === "build" || call[0] === "image"), false);
  assert.deepEqual(result.calls.at(-1), ["builder", "prune", "-f"]);
});

test("an unstarted fixture never touches Docker during close", () => {
  const result = run({ unstarted: true });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, []);
});

test("closing the same fixture twice does not repeat image removal or builder pruning", () => {
  const result = run({ twice: true });
  assert.equal(result.status, 0, result.output);
  assertBuiltImageRemoved(result.calls);
});
