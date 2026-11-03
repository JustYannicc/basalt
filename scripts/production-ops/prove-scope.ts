import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const registry = new URL(
  "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/migrations.ts",
  import.meta.url,
);
const fixture = new URL("./scope-proof-fixture.ts", registry);
const database = new URL(
  "../../.upstream/apps/hosted/cloud/src/infrastructure/database.ts",
  import.meta.url,
);
const originalDatabase = await readFile(database, "utf8");
const originFixture = new URL("./database-origin-fixture.ts", database);
const originSource = await readFile(new URL("./database-origin.fixture", import.meta.url), "utf8");
const originMarker = 'connectionString: yield* Output.named(database.url, "DatabaseUrl")';
assert.ok(originalDatabase.includes(originMarker), "Expected the actual direct origin binding");
const expectedDatabase =
  'import { databaseOriginFixture } from "./database-origin-fixture.ts";\n' +
  originalDatabase.replace(
    originMarker,
    'connectionString: yield* Output.named(globalThis.__ALCHEMY_RUNTIME__ ? database.url : database.url.pipe(Output.map(databaseOriginFixture)), "DatabaseUrl")',
  );
const original = await readFile(registry, "utf8");
assert.match(original, /export const productionMigrations/);
assert.ok(!original.includes('"scope-proof"'), "The proof name must not shadow a migration");
const source = await readFile(new URL("./scope-proof.fixture", import.meta.url), "utf8");
await writeFile(fixture, source, { flag: "wx" });
await writeFile(originFixture, originSource, { flag: "wx" });
let expected = original;
try {
  await writeFile(database, expectedDatabase);
  expected =
    'import { scopeProof } from "./scope-proof-fixture.ts";\n' +
    original +
    '\nObject.assign(productionMigrations, { "scope-proof": scopeProof });\n';
  await writeFile(registry, expected);
  const configDirectory = `${root}/.generated/production-ops-scope-proof`;
  await mkdir(configDirectory, { recursive: true });
  const config = `${configDirectory}/tsconfig.json`;
  await writeFile(
    config,
    JSON.stringify({
      extends: `${root}/.upstream/tsconfig.json`,
      include: [fileURLToPath(fixture), fileURLToPath(database)],
      exclude: [],
      compilerOptions: { typeRoots: [`${root}/.upstream/node_modules/@types`] },
    }),
  );
  const checked = spawnSync(
    `${root}/.upstream/node_modules/.bin/tsc-rs`,
    ["--noEmit", "-p", config],
    { cwd: root, stdio: "inherit" },
  );
  assert.equal(checked.status, 0, "The proof-only migration must pass the product typecheck");
  const child = spawn(
    "bun",
    [
      "run",
      "e2e:cloud",
      "--test-name",
      process.env.BASALT_SCOPE_PROOF_PATTERN ?? "^Cloud production operations enforce",
      "--workers",
      "1",
    ],
    {
      cwd: `${root}/.upstream`,
      stdio: "inherit",
      env: { ...process.env, BASALT_E2E_PRODUCTION_OPS: "1" },
    },
  );
  const interrupt = () => child.kill("SIGINT");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
} finally {
  assert.equal(await readFile(registry, "utf8"), expected, "The registry changed during the proof");
  assert.equal(
    await readFile(database, "utf8"),
    expectedDatabase,
    "The direct origin binding changed during the proof",
  );
  await writeFile(registry, original);
  await writeFile(database, originalDatabase);
  await unlink(fixture);
  await unlink(originFixture);
  console.log(
    "Restored the migration registry and direct origin binding; removed proof-only modules",
  );
}
