import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseShard, shardIds } from "./catalog-compat/shard.ts";
import { trackedFiles } from "./ci/import-graph.ts";
import { ownedUnitSuite } from "./ci/unit-tests.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = fileURLToPath(new URL("./ci/unit-tests.ts", import.meta.url));
const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const job = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")).jobs["fast-units"];
// Each leg's UNIT_SHARD, as Actions renders `${{ matrix.leg }}/${{ strategy.job-total }}`.
const shards = (job.strategy.matrix.leg as number[]).map((leg, _, legs) => `${leg}/${legs.length}`);

test("the unit legs' shards are 1..n of n, and both unit steps take one", () => {
  assert.deepEqual(shards, ["1/2", "2/2"]);
  for (const name of ["Run focused owned unit tests", "Run the complete owned unit suite"]) {
    const step = job.steps.find((step: { name?: string }) => step.name === name);
    assert.equal(step.env.UNIT_SHARD, "${{ matrix.leg }}/${{ strategy.job-total }}", name);
    assert.match(step.run, /^node scripts\/ci\/unit-tests\.ts(?: --all)?$/, name);
  }
});

test("the legs together run the complete owned unit suite, each file in exactly one leg", () => {
  const { tests } = ownedUnitSuite(root);
  // The suite is the tracked files `npm run check` names, as node --test's own glob finds them; a
  // CI checkout has no untracked test files, so there it is exactly what `npm run check` runs.
  const command: string = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts
    .check;
  const patterns = command.split(/\s+/).filter((arg) => arg !== "node" && !arg.startsWith("-"));
  const tracked = new Set(trackedFiles(root));
  const found = globSync(patterns, { cwd: root, exclude: (name) => name === "node_modules" });
  assert.deepEqual(
    [...tests].sort(),
    [...new Set(found)].filter((file) => tracked.has(file)).sort(),
  );
  const legs = shards.map((shard) => shardIds(tests, parseShard(shard)));
  const listed = legs.flat();
  assert.deepEqual([...listed].sort(), [...tests].sort());
  assert.equal(new Set(listed).size, listed.length);
  for (const leg of legs) assert.ok(leg.length > tests.length / 6, String(leg.length));
  // A file's leg depends on its path only, so adding a file moves no other file.
  const grown = shards.map((shard) =>
    shardIds([...tests, "scripts/zz-new.test.ts"], parseShard(shard)).filter(
      (file) => file !== "scripts/zz-new.test.ts",
    ),
  );
  assert.deepEqual(grown, legs);
});

test("each leg of the runner runs only its own files, and a leg with none passes", () => {
  const fixture = mkdtempSync(join(tmpdir(), "unit-shards-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ scripts: { check: "node --test scripts/*.test.mjs" } }),
    );
    for (const name of names)
      writeFileSync(
        join(fixture, `scripts/${name}.test.mjs`),
        `import { test } from "node:test";\ntest("ran ${name}", () => {});\n`,
      );
    execFileSync("git", ["init", "-q"], { cwd: fixture });
    execFileSync("git", ["add", "."], { cwd: fixture });
    const ran = (shard: string, args: string[] = ["--all"]) => {
      const result = spawnSync(process.execPath, [runner, ...args], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, UNIT_SHARD: shard },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return [...result.stdout.matchAll(/ran (\w)/g)].map((match) => match[1]!);
    };
    const legs = ["1/3", "2/3", "3/3"].map((shard) => ran(shard));
    assert.deepEqual(legs.flat().sort(), names);
    assert.equal(new Set(legs.flat()).size, names.length);
    assert.deepEqual(ran(""), names);
    // One file and three legs: two legs have nothing to run and still pass.
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ scripts: { check: "node --test scripts/a.test.mjs" } }),
    );
    assert.deepEqual(["1/3", "2/3", "3/3"].map((shard) => ran(shard)).flat(), ["a"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
