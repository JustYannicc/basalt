import { patternForGroup } from "../ci/declarations.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { discardGate } from "./gate.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const upstream = `${root}.upstream`;
const database = `${upstream}/apps/hosted/cloud/src/infrastructure/database.ts`;
const executor = `${upstream}/apps/hosted/cloud/src/infrastructure/executor.ts`;
const fixture = `${upstream}/apps/hosted/cloud/src/infrastructure/oauth-discard-fixture.ts`;
const suite = `${upstream}/e2e/sdk/suite.ts`;
const originals = new Map(
  await Promise.all(
    [database, executor, suite].map(async (path) => [path, await readFile(path, "utf8")] as const),
  ),
);
const poolMarker = "      return Context.add(sql, OpenedConnections, { count: () => opened });";
const backgroundMarker = "      const background = yield* makeHostedBackgroundWork;";
const lifecycleMarker = "      const lifecycle = yield* hostedResourceLifecycle.pipe(";
const environmentMarker = '                          PATH: process.env.PATH ?? "",';
for (const [path, marker] of [
  [database, poolMarker],
  [executor, backgroundMarker],
  [executor, lifecycleMarker],
  [suite, environmentMarker],
] as const)
  assert.ok(originals.get(path)!.includes(marker), `Missing native proof boundary in ${path}`);
const gate = await discardGate();
const expected = new Map([
  [
    database,
    'import { withDiscardGate } from "./oauth-discard-fixture.ts";\n' +
      originals.get(database)!.replace(
        poolMarker,
        `      const client = Context.get(sql, PgClient.PgClient);
      const transaction = client.withTransaction;
      Object.assign(client, {
        withTransaction: <A, E, R>(work: Effect.Effect<A, E, R>) => withDiscardGate(work, transaction),
      });
${poolMarker}`,
      ),
  ],
  [
    executor,
    'import { observeDiscardWork } from "./oauth-discard-fixture.ts";\n' +
      originals
        .get(executor)!
        .replace(
          backgroundMarker,
          "      const nativeBackground = yield* makeHostedBackgroundWork;",
        )
        .replace(
          lifecycleMarker,
          `      const background = (work: Effect.Effect<void>) => observeDiscardWork(nativeBackground, work);\n${lifecycleMarker}`,
        ),
  ],
  [
    suite,
    originals
      .get(suite)!
      .replace(
        environmentMarker,
        `${environmentMarker}\n                          EXECUTOR_OAUTH_DISCARD_GATE: ${JSON.stringify(gate.origin)},`,
      ),
  ],
]);
const written = new Set<string>();
let fixtureWritten = false;
try {
  await writeFile(
    fixture,
    (await readFile(new URL("./runtime.fixture", import.meta.url), "utf8")).replace(
      "__GATE_ORIGIN__",
      gate.origin,
    ),
    { flag: "wx" },
  );
  fixtureWritten = true;
  for (const [path, source] of expected) {
    await writeFile(path, source);
    written.add(path);
  }
  const directory = `${root}.generated/oauth-discard-proof`;
  await mkdir(directory, { recursive: true });
  const config = `${directory}/tsconfig.json`;
  await writeFile(
    config,
    JSON.stringify({
      extends: `${upstream}/tsconfig.json`,
      include: [
        database,
        executor,
        `${upstream}/apps/hosted/cloud/src/contracts/native-workflows.d.ts`,
        `${upstream}/e2e/tests/oauth-discarded-refresh.spec.ts`,
      ],
      exclude: [],
      compilerOptions: { typeRoots: [`${upstream}/node_modules/@types`] },
    }),
  );
  const checked = spawnSync(`${upstream}/node_modules/.bin/tsc-rs`, ["--noEmit", "-p", config], {
    cwd: root,
    stdio: "inherit",
  });
  assert.equal(checked.status, 0, "Disposable SQL gates and regression must typecheck");
  const child = spawn(
    "bun",
    ["run", "e2e:cloud", "--test-name", patternForGroup("oauth:discard"), "--workers", "1"],
    {
      cwd: upstream,
      stdio: "inherit",
      env: { ...process.env, EXECUTOR_OAUTH_DISCARD_GATE: gate.origin },
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
  try {
    for (const path of written) {
      assert.equal(
        await readFile(path, "utf8"),
        expected.get(path),
        "Proof source changed while running",
      );
      await writeFile(path, originals.get(path)!);
    }
    if (fixtureWritten) await unlink(fixture);
  } finally {
    await gate.close();
  }
  console.log("Restored native SQL, background scheduling and E2E worker files");
}
