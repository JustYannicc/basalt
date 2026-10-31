import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Effect, Schedule } from "effect";
import { root, runtime } from "./recipes/harness.mjs";
import { poolCloudHarness } from "./recipes/pool-cloud-harness.mjs";
import { verifyPoolJourneys } from "./recipes/pool-journeys.mjs";
import { verifyPoolNegativeControls } from "./recipes/pool-negative-controls.mjs";
import { verifyPoolCheckFailures } from "./recipes/pool-check-failures.mjs";

const directory = resolve(
  process.argv[2] ?? join(root, ".generated/pool-recipe-checks", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(join(root, ".upstream"));
const checks = [];
const checked = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
const program = Effect.gen(function* () {
  const h = yield* poolCloudHarness(directory);
  const identity = yield* h.request("GET", "/api/auth/get-session");
  const pool = yield* h.request("GET", `${h.prefix}/apps`).pipe(
    Effect.flatMap((apps) => {
      const app = apps.find((app) => app.name === `${identity.user.name}'s pool`);
      return app
        ? Effect.succeed(app)
        : Effect.fail("normal onboarding must provision the owner's pool app");
    }),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 240 }),
  );
  h.fixture.seed(pool.id, "synthetic-account-a");
  const view = yield* h.call(pool.id, "view");
  checked("native onboarding provisions the real pool app", view.ok, true);
  checked("provisioned pool token reaches the production control API", view.value?.isOwner, true);
  checked(
    "native pool view contains synthetic Home observations",
    view.value.accounts[0]?.id,
    "synthetic-account-a",
  );
  const scenario = yield* verifyPoolJourneys(h, pool, checked);
  const negativeControls = yield* verifyPoolNegativeControls(h, pool, scenario, checked);
  const repeatedChecks = yield* verifyPoolCheckFailures(h, pool, scenario, checked);
  return {
    checks,
    negativeControls,
    repeatedChecks,
    runtimeDirectory: h.runtimeDirectory,
    syntheticMessagesOnly: true,
  };
});
try {
  const report = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(runtime)));
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify({ checks: report.checks.length, directory }));
} catch (error) {
  await writeFile(join(directory, "partial-checks.json"), JSON.stringify(checks, null, 2), {
    mode: 0o600,
  });
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("Native pool recipe proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
