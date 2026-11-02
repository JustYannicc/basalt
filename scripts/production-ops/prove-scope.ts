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
const original = await readFile(registry, "utf8");
assert.match(original, /export const productionMigrations/);
assert.ok(!original.includes('"scope-proof"'), "The proof name must not shadow a migration");
const source = await readFile(new URL("./scope-proof.fixture", import.meta.url), "utf8");
await writeFile(fixture, source, { flag: "wx" });
let expected = original;
try {
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
      include: [fileURLToPath(fixture)],
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
    ["run", "e2e:cloud", "--test-name", "^Cloud production operations enforce", "--workers", "1"],
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
  await writeFile(registry, original);
  await unlink(fixture);
  console.log("Restored the migration registry and removed the proof-only module");
}
