import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseShard } from "./catalog-compat/shard.ts";
import {
  imageChain,
  partsByTime,
  poolTestFiles,
  poolTestShards,
  poolTestTimesFile,
} from "./ci/pool-test-shard.ts";
import { fileSeconds } from "./ci/pool-test-times.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const job = parse(read(".github/workflows/ci.yml")).jobs["pool-runtime"];
const step = (name: string) =>
  job.steps.find((candidate: { name?: string }) => candidate.name === name);
const contractsStep = step("Check the pool runtime and database contracts");
const allPoolTests = () =>
  readdirSync(new URL("./pool-tests/", import.meta.url))
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => `scripts/pool-tests/${file}`)
    .sort();
// What each matrix row's contracts step lists, as the step's own command line runs it.
const listLegs = () =>
  (job.strategy.matrix.include as { shard: string; part?: string }[]).map((row) => {
    const part = row.part || "1/1";
    const files = execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./ci/pool-test-shard.ts", import.meta.url)), row.shard, part],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    return { ...row, part, files };
  });

test("the pool-runtime shards run every pool test file exactly once", () => {
  const shards = poolTestShards.map((shard) => poolTestFiles(root, shard));
  const all = allPoolTests();
  assert.deepEqual(shards.flat().sort(), all);
  assert.equal(new Set(shards.flat()).size, all.length);
  for (const files of shards) assert.ok(files.length > 0);
  // No contracts file loads the compatibility images, so none may read the variables the
  // workflow points at them.
  const loaded = [
    ...read(".github/actions/pool-compatibility-images/action.yml").matchAll(/--tag (\S+)/g),
  ].map((match) => match[1]);
  const variables = Object.entries<string>(contractsStep.env)
    .filter(([, value]) => loaded.includes(value))
    .map(([name]) => name);
  assert.ok(variables.length >= 2, "the contracts step names the compatibility images");
  const compatibility = poolTestFiles(root, "compatibility");
  for (const file of all.filter((path) => !compatibility.includes(path)))
    for (const variable of variables)
      assert.ok(!read(file).includes(variable), file + " " + variable);
  for (const variable of variables)
    assert.ok(
      compatibility.some((file) => read(file).includes(variable)),
      variable,
    );
});

test("a file that reaches the pool image runs in the image shard, the rest in the Postgres-only parts", () => {
  const image = poolTestFiles(root, "contracts-image");
  const postgres = poolTestFiles(root, "contracts-postgres");
  for (const file of image) assert.ok(imageChain(root, file), file);
  for (const file of postgres) assert.equal(imageChain(root, file), undefined, file);
  // Files reach the image through the shared fixtures that start it, not only by naming it.
  assert.ok(image.some((file) => (imageChain(root, file)?.length ?? 0) > 1));
  // Anchors in the real tree: these start the image or a container; this one needs PostgreSQL only.
  for (const file of [
    "scripts/pool-tests/container.test.ts",
    "scripts/pool-tests/database-startup.test.ts",
  ])
    assert.ok(image.includes(file), file);
  assert.ok(postgres.includes("scripts/pool-tests/capture-postgres.test.ts"));
});

test("the image rule follows what a file loads, and a new file needs no list", () => {
  const tree = mkdtempSync(join(tmpdir(), "pool-test-shard-"));
  try {
    const write = (path: string, text: string) => {
      mkdirSync(join(tree, path, ".."), { recursive: true });
      writeFileSync(join(tree, path), text);
    };
    write(
      "scripts/pool-tests/image-fixture.ts",
      "export const tag = process.env.POOL_TEST_IMAGE;\n",
    );
    write("scripts/pool-tests/runner.ts", 'export const run = ["docker", "run"];\n');
    write("scripts/pool-tests/helper.ts", 'export { tag } from "./image-fixture.ts";\n');
    write("scripts/pool-tests/a-direct.test.ts", 'import { tag } from "./image-fixture.ts";\n');
    write("scripts/pool-tests/b-through-a-helper.test.ts", 'import { tag } from "./helper.ts";\n');
    write(
      "scripts/pool-tests/c-spawns.test.ts",
      // A relative path held in a variable and loaded later, as several pool tests load workers.
      'const helper = "./runner.ts";\nawait import(helper);\n',
    );
    write("scripts/pool-tests/d-postgres.test.ts", 'import { test } from "node:test";\n');
    write("scripts/pool-tests/e-postgres.test.ts", "export {};\n");
    write("scripts/pool-tests/f-legacy.test.ts", "process.env.POOL_TEST_LEGACY_IMAGE;\n");
    write(
      poolTestTimesFile,
      JSON.stringify({ seconds: { "scripts/pool-tests/d-postgres.test.ts": 60 } }),
    );
    // The import graph reads the files git tracks.
    execFileSync("git", ["init", "-q"], { cwd: tree });
    execFileSync("git", ["add", "-A"], { cwd: tree });
    assert.deepEqual(poolTestFiles(tree, "contracts-image"), [
      "scripts/pool-tests/a-direct.test.ts",
      "scripts/pool-tests/b-through-a-helper.test.ts",
      "scripts/pool-tests/c-spawns.test.ts",
    ]);
    assert.deepEqual(poolTestFiles(tree, "compatibility"), ["scripts/pool-tests/f-legacy.test.ts"]);
    // e has no recorded time: it counts the median recorded time and lands on the emptier part.
    assert.deepEqual(poolTestFiles(tree, "contracts-postgres", parseShard("1/2")), [
      "scripts/pool-tests/d-postgres.test.ts",
    ]);
    assert.deepEqual(poolTestFiles(tree, "contracts-postgres", parseShard("2/2")), [
      "scripts/pool-tests/e-postgres.test.ts",
    ]);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test("recorded times cut parts longest first, and a stale or missing time never drops a file", () => {
  const files = ["a", "b", "c", "d", "e"];
  // e has no time and counts the median, 60: a 100, then b 60, e 60, c 50, d 10 onto the emptier part.
  assert.deepEqual(partsByTime(files, { a: 100, b: 60, c: 50, d: 10 }, 2), [
    ["a", "c"],
    ["b", "d", "e"],
  ]);
  // Times for files that no longer exist are ignored; files without a time still run.
  const parts = partsByTime(files, { gone: 1000, a: 5 }, 3);
  assert.deepEqual(parts.flat().sort(), files);
  assert.equal(new Set(parts.flat()).size, files.length);
  assert.deepEqual(partsByTime([], {}, 2), [[], []]);
  // With no time recorded at all, files still spread over every part.
  assert.deepEqual(partsByTime(["a", "b", "c", "d"], {}, 3), [["a", "d"], ["b"], ["c"]]);
});

test("the recorded times cover the Postgres-only files", () => {
  const seconds = JSON.parse(read(poolTestTimesFile)).seconds as Record<string, number>;
  const postgres = poolTestFiles(root, "contracts-postgres");
  const missing = postgres.filter((file) => seconds[file] === undefined);
  assert.ok(
    missing.length <= postgres.length / 10,
    `refresh ${poolTestTimesFile}: ${missing.join(", ")}`,
  );
});

test("a job log's progress lines give each file's seconds", () => {
  const line = (at: string, phase: string, file: string) =>
    `${at} OWNED_TEST ${JSON.stringify({ phase, file, name: "t" })}`;
  const log = [
    line("2026-11-27T21:18:05.000Z", "start", "scripts/pool-tests/a.test.ts"),
    "2026-11-27T21:18:06.000Z ✔ t (900ms)",
    line("2026-11-27T21:18:07.500Z", "complete", "scripts/pool-tests/a.test.ts"),
    line("2026-11-27T21:18:07.600Z", "start", "scripts/pool-tests/b.test.ts"),
    line("2026-11-27T21:20:07.600Z", "complete", "scripts/pool-tests/b.test.ts"),
    line("2026-11-27T21:20:08.000Z", "start", "scripts/other.test.ts"),
  ].join("\n");
  assert.deepEqual(fileSeconds([log]), {
    "scripts/pool-tests/a.test.ts": 3,
    "scripts/pool-tests/b.test.ts": 120,
  });
});

test("the matrix legs split each shard into parts that run each of its files exactly once", () => {
  const legs = listLegs();
  assert.equal(contractsStep.env.POOL_TEST_PART, "${{ matrix.part || '1/1' }}");
  assert.match(contractsStep.run, /pool-test-shard\.ts "\$POOL_TEST_SHARD" "\$POOL_TEST_PART"/);
  assert.deepEqual([...new Set(legs.map((leg) => leg.shard))].sort(), [...poolTestShards].sort());
  for (const shard of poolTestShards) {
    const rows = legs.filter((leg) => leg.shard === shard);
    const parts = rows.map((leg) => parseShard(leg.part));
    // Parts 1..n of one n: no part is missing or repeated.
    assert.deepEqual(
      parts.map((part) => part.shard),
      Array.from({ length: parts.length }, (_, index) => index + 1),
      shard,
    );
    assert.ok(
      parts.every((part) => part.shards === parts.length),
      shard,
    );
    const listed = rows.flatMap((leg) => leg.files);
    assert.deepEqual([...listed].sort(), poolTestFiles(root, shard), shard);
    assert.equal(new Set(listed).size, listed.length, shard);
    for (const leg of rows) assert.ok(leg.files.length > 0, `${shard} ${leg.part}`);
  }
  // The Postgres-only files, most of the suite's time, run in three legs.
  assert.equal(legs.filter((leg) => leg.shard === "contracts-postgres").length, 3);
  // Both contracts shards compile the SQLite worker their files read.
  assert.equal(
    step("Compile and serve the SQLite upload worker assets").if,
    "matrix.shard != 'compatibility'",
  );
});

test("the Postgres-only legs build no image and fail on any docker use", () => {
  for (const name of [
    "Free runner disk before pool builds",
    "Build the pinned pool image",
    "Verify the container-to-host probe's time limit and failures",
    "Verify containers can reach the host fixture listeners",
  ])
    assert.equal(step(name).if, "matrix.shard != 'contracts-postgres'", name);
  const lines = contractsStep.run.split("\n").map((line: string) => line.trim());
  const guard = lines.indexOf('if [ "$POOL_TEST_SHARD" = contracts-postgres ]; then');
  const run = lines.findIndex((line: string) => line.startsWith("node --test "));
  assert.ok(guard >= 0 && guard < run, "the guard runs before the tests");
  assert.ok(
    lines.slice(guard, run).includes("export POOL_TEST_IMAGE=no-image-in-postgres-only-pool-tests"),
  );
  assert.ok(
    lines
      .slice(guard, run)
      .includes(
        "export DOCKER_HOST=unix:///nonexistent/no-docker-in-postgres-only-pool-tests.sock",
      ),
  );
});
