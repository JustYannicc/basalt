import { patternForGroup } from "../ci/declarations.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { oauthRemovalGate } from "./gate.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const upstream = `${root}.upstream`;
const database = `${upstream}/apps/hosted/cloud/src/infrastructure/database.ts`;
const fixture = `${upstream}/apps/hosted/cloud/src/infrastructure/oauth-removal-gate-fixture.ts`;
const suite = `${upstream}/e2e/sdk/suite.ts`;
const original = await readFile(database, "utf8");
const originalSuite = await readFile(suite, "utf8");
const marker = "      return Context.add(sql, OpenedConnections, { count: () => opened });";
const environmentMarker = '                          PATH: process.env.PATH ?? "",';
assert.ok(original.includes(marker), "Expected the native Cloud SQL pool");
assert.ok(originalSuite.includes(environmentMarker), "Expected the E2E worker environment");
const gate = await oauthRemovalGate();
const expected =
  'import { withOAuthRemovalGate } from "./oauth-removal-gate-fixture.ts";\n' +
  original.replace(
    marker,
    `      const client = Context.get(sql, PgClient.PgClient);
      const transaction = client.withTransaction;
      Object.assign(client, {
        withTransaction: <A, E, R>(work: Effect.Effect<A, E, R>) => withOAuthRemovalGate(work, transaction),
      });
${marker}`,
  );
const expectedSuite = originalSuite.replace(
  environmentMarker,
  `${environmentMarker}\n                          EXECUTOR_OAUTH_REMOVAL_GATE: ${JSON.stringify(gate.origin)},`,
);
try {
  await writeFile(
    fixture,
    (await readFile(new URL("./sql-gate.fixture", import.meta.url), "utf8")).replace(
      "__GATE_ORIGIN__",
      gate.origin,
    ),
    { flag: "wx" },
  );
  await writeFile(database, expected);
  await writeFile(suite, expectedSuite);
  const directory = `${root}.generated/oauth-removal-proof`;
  await mkdir(directory, { recursive: true });
  const config = `${directory}/tsconfig.json`;
  await writeFile(
    config,
    JSON.stringify({
      extends: `${upstream}/tsconfig.json`,
      include: [
        database,
        `${upstream}/apps/hosted/cloud/src/contracts/native-workflows.d.ts`,
        `${upstream}/e2e/tests/oauth-account-removal.spec.ts`,
        `${upstream}/e2e/tests/oauth-identification-removal.spec.ts`,
      ],
      exclude: [],
      compilerOptions: { typeRoots: [`${upstream}/node_modules/@types`] },
    }),
  );
  const checked = spawnSync(`${upstream}/node_modules/.bin/tsc-rs`, ["--noEmit", "-p", config], {
    cwd: root,
    stdio: "inherit",
  });
  assert.equal(checked.status, 0, "Proof-only SQL gates and regression must typecheck");
  const child = spawn(
    "bun",
    ["run", "e2e:cloud", "--test-name", patternForGroup("oauth:removal"), "--workers", "1"],
    {
      cwd: upstream,
      stdio: "inherit",
      env: { ...process.env, EXECUTOR_OAUTH_REMOVAL_GATE: gate.origin },
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
  assert.equal(await readFile(database, "utf8"), expected, "The SQL pool changed during the proof");
  assert.equal(
    await readFile(suite, "utf8"),
    expectedSuite,
    "The E2E worker changed during the proof",
  );
  await writeFile(database, original);
  await writeFile(suite, originalSuite);
  await unlink(fixture);
  await gate.close();
  console.log("Restored the native SQL pool and removed its disposable gates");
}
