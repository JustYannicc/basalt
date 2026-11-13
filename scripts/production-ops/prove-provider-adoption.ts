import { patternForGroup } from "../ci/declarations.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { adoptionStepGate } from "./adoption-step-gate.ts";
import { adoptionProofSelection } from "./adoption-shards.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--shard"),
  "Usage: prove-provider-adoption.ts [--shard 1/2|2/2]",
);
const { scenarios } = await import("../../.upstream/e2e/test-plan.ts");
const selection = adoptionProofSelection(
  scenarios,
  process.env.BASALT_ADOPTION_PROOF_PATTERN ?? patternForGroup("production-ops:adoption"),
  args[1],
);
console.log(`Provider adoption ${args[1] ?? "all"}: ${selection.ids.join(", ")}`);
const database = new URL(
  "../../.upstream/apps/hosted/cloud/src/infrastructure/database.ts",
  import.meta.url,
);
const fixture = new URL("./adoption-step-gate-fixture.ts", database);
const original = await readFile(database, "utf8");
const suite = new URL("../../.upstream/e2e/sdk/suite.ts", import.meta.url);
const originalSuite = await readFile(suite, "utf8");
const environmentMarker = '                          PATH: process.env.PATH ?? "",';
assert.ok(originalSuite.includes(environmentMarker), "Expected the E2E worker environment");
const marker = "      return Context.add(sql, OpenedConnections, { count: () => opened });";
assert.ok(original.includes(marker), "Expected the actual Cloud SQL pool");
const gate = await adoptionStepGate();
const source = (
  await readFile(new URL("./adoption-step-gate.fixture", import.meta.url), "utf8")
).replace("__ADOPTION_STEP_GATE_ORIGIN__", gate.origin);
await writeFile(fixture, source, { flag: "wx" });
const expected =
  'import { withAdoptionStepGate } from "./adoption-step-gate-fixture.ts";\n' +
  original.replace(
    marker,
    `      const client = Context.get(sql, PgClient.PgClient);
      const transaction = client.withTransaction;
      Object.assign(client, {
        withTransaction: <A, E, R>(work: Effect.Effect<A, E, R>) => withAdoptionStepGate(work, transaction),
      });
${marker}`,
  );
const expectedSuite = originalSuite.replace(
  environmentMarker,
  `${environmentMarker}\n                          BASALT_ADOPTION_STEP_GATE: ${JSON.stringify(gate.origin)},`,
);
try {
  await writeFile(database, expected);
  await writeFile(suite, expectedSuite);
  const directory = `${root}/.generated/provider-adoption-proof`;
  await mkdir(directory, { recursive: true });
  const config = `${directory}/tsconfig.json`;
  await writeFile(
    config,
    JSON.stringify({
      extends: `${root}/.upstream/tsconfig.json`,
      include: [fileURLToPath(database)],
      exclude: [],
      compilerOptions: { typeRoots: [`${root}/.upstream/node_modules/@types`] },
    }),
  );
  const checked = spawnSync(
    `${root}/.upstream/node_modules/.bin/tsc-rs`,
    ["--noEmit", "-p", config],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  assert.equal(checked.status, 0, "The proof-only SQL gate must typecheck");
  const child = spawn(
    "bun",
    [
      "run",
      "e2e:cloud",
      "--test-name",
      selection.pattern,
      "--workers",
      process.env.BASALT_ADOPTION_PROOF_WORKERS ?? "2",
    ],
    {
      cwd: `${root}/.upstream`,
      stdio: "inherit",
      env: {
        ...process.env,
        BASALT_E2E_PRODUCTION_OPS: "1",
        BASALT_E2E_POOL_BACKEND: "1",
        BASALT_ADOPTION_STEP_GATE: gate.origin,
      },
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
  console.log("Restored the actual SQL pool and removed its proof-only gate");
}
