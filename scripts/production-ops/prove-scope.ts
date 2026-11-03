import { selectScopeCases } from "./scope-cases.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
assert.ok(
  !process.env.E2E_CLOUD_URL,
  "Scope proofs require a managed disposable Cloud, not E2E_CLOUD_URL",
);
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
const runtimeMarker = 'Output.map((origin) => ({ ...origin, sslmode: "disable" as const }))';
assert.ok(originalDatabase.includes(runtimeMarker), "Expected the actual runtime SQL binding");
const expectedDatabase =
  'import { databaseOriginFixture, runtimeDatabaseOriginFixture } from "./database-origin-fixture.ts";\n' +
  originalDatabase
    .replace(
      originMarker,
      'connectionString: yield* Output.named(globalThis.__ALCHEMY_RUNTIME__ ? database.url : database.url.pipe(Output.map(databaseOriginFixture)), "DatabaseUrl")',
    )
    .replace(
      "origin: local.origin,",
      "origin: local.origin.pipe(Output.map(runtimeDatabaseOriginFixture)),",
    )
    .replace(
      runtimeMarker,
      'Output.map((origin) => ({ ...runtimeDatabaseOriginFixture(origin), sslmode: "disable" as const }))',
    );
const http = new URL("./production-ops/http.ts", database);
const originalHttp = await readFile(http, "utf8");
const expectedHttp = originalHttp
  .replace(
    "const directConnection = yield* cloudDirectDatabaseConnection;",
    'const directConnection = yield* cloudDirectDatabaseConnection;\n  const proofRelease = yield* Config.String("BASALT_E2E_OPS_RELEASE");',
  )
  .replace("release: productionOpsRelease,", "release: proofRelease,");
assert.notEqual(originalHttp, expectedHttp, "Expected the release binding");
const original = await readFile(registry, "utf8");
assert.match(original, /export const productionMigrations/);
assert.ok(!original.includes('"scope-proof"'), "The proof name must not shadow a migration");
const source = await readFile(new URL("./scope-proof.fixture", import.meta.url), "utf8");
await writeFile(fixture, source, { flag: "wx" });
await writeFile(originFixture, originSource, { flag: "wx" });
let expected = original;
try {
  await writeFile(database, expectedDatabase);
  await writeFile(http, expectedHttp);
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
  const { scenarios } = await import("../../.upstream/e2e/test-plan.ts");
  const cases = selectScopeCases(
    scenarios,
    process.env.BASALT_SCOPE_PROOF_PATTERN ?? "^Cloud production operations enforce",
  );
  const buildStarted = Date.now();
  const built = spawnSync("bun", ["run", "framework:build"], {
    cwd: `${root}/.upstream/apps/hosted/cloud`,
    stdio: "inherit",
  });
  assert.equal(built.status, 0, "The shared Cloud framework must build before isolated proofs");
  console.log(
    `Shared Cloud framework built once in ${Date.now() - buildStarted}ms for ${cases.length} isolated proofs`,
  );
  for (const scenario of cases) {
    console.log(`Isolated scope proof: ${scenario.title}`);
    const evidenceRoot = `${root}/.upstream/.local/e2e`;
    await mkdir(evidenceRoot, { recursive: true });
    const previousRuns = new Set(await readdir(evidenceRoot));
    const environment = { ...process.env };
    delete environment.BASALT_E2E_PREBOOT_BINDING;
    const child = spawn(
      "bun",
      [
        "run",
        "e2e:cloud",
        "--test-name",
        scenario.pattern,
        "--workers",
        "1",
        "--prebuilt-framework",
      ],
      {
        cwd: `${root}/.upstream`,
        stdio: "inherit",
        env: {
          ...environment,
          BASALT_E2E_PRODUCTION_OPS: "1",
          ...(scenario.binding === undefined
            ? {}
            : { BASALT_E2E_PREBOOT_BINDING: scenario.binding }),
        },
      },
    );
    const interrupt = () => child.kill("SIGINT");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolve(code ?? 1));
      });
      if (code !== 0) {
        process.exitCode = code;
        break;
      }
      const runs = (await readdir(evidenceRoot)).filter((name) => !previousRuns.has(name));
      assert.equal(runs.length, 1, "One isolated Cloud run must own this case's evidence");
      const directory = `${evidenceRoot}/${runs[0]}/cloud`;
      const metadata = JSON.parse(await readFile(`${directory}/environment.json`, "utf8"));
      assert.equal(
        metadata.prebuiltFramework,
        true,
        "Each isolated run must reuse the shared framework",
      );
      if (scenario.binding !== undefined) {
        const ready = JSON.parse(await readFile(`${directory}/runtime-preboot.json`, "utf8"));
        const launches = (await readFile(`${directory}/runtime-launches.ndjson`, "utf8"))
          .trim()
          .split("\n");
        const switches = (await readFile(`${directory}/runtime-switches.ndjson`, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(ready.binding, scenario.binding);
        assert.equal(ready.launches, 2);
        assert.equal(launches.length, 2, "Fixture switches must not launch another Cloud runtime");
        assert.ok(switches.some((entry) => entry.binding === scenario.binding));
        assert.ok(switches.every((entry) => entry.launches === 2));
        console.log(
          `Verified two prebooted runtimes and ${switches.length} switches without relaunch`,
        );
      }
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
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
  assert.equal(
    await readFile(http, "utf8"),
    expectedHttp,
    "The release binding changed during the proof",
  );
  await writeFile(http, originalHttp);
  await unlink(fixture);
  await unlink(originFixture);
  console.log(
    "Restored the migration registry and direct origin binding; removed proof-only modules",
  );
}
