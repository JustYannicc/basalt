import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { recipeHarness, runtime, root, appsManifest, until } from "./recipes/harness.mjs";
import { startRecipeUpstream } from "./recipes/upstream.mjs";
import { scenarios } from "../.upstream/e2e/test-plan.ts";

const directory = resolve(process.argv[2] ?? join(root, ".generated/departure-recipe-checks"));
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(join(root, ".upstream"));
const checks = [];
const checked = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
const program = Effect.gen(function* () {
  const fixture = yield* Effect.acquireRelease(Effect.promise(startRecipeUpstream), (value) =>
    Effect.promise(() => value.stop()),
  );
  // Extend the retained-diagnostics upgrade journey with the actual catalog consumer.
  const h = yield* recipeHarness(
    directory,
    fixture.origin,
    scenarios.contributedDepartureRetainedDiagnostics.title,
  );
  const deploy = (name, files) =>
    h.request("POST", `${h.prefix}/apps/deploy`, { name, files: [...files, appsManifest] });
  const pool = yield* deploy("Synthetic contributed pool", [
    {
      path: "index.ts",
      content: `
import { defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "Synthetic contributed account", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ app: { accounts: { shared: service.many().contributed() } } }, {});`,
    },
  ]);
  const delayedPool = yield* deploy("Synthetic delayed contribution pool", [
    {
      path: "index.ts",
      content: `
import { defineApp, defineProvider, secrets, object, string } from "apps";
const service = defineProvider({ name: "Synthetic delayed account", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ app: { accounts: { shared: service.many().contributed() } } }, {});`,
    },
  ]);
  const delayedConnection = yield* h.request(
    "POST",
    `${h.appPath(delayedPool.id)}/accounts/app/shared/connections`,
    {},
  );
  const delayedAccount = yield* h.request(
    "POST",
    `${h.prefix}/connections/${delayedConnection.id}/submit`,
    { method: "key", fields: { token: "synthetic-delayed-only" } },
  );
  const connection = yield* h.request(
    "POST",
    `${h.appPath(pool.id)}/accounts/app/shared/connections`,
    {},
  );
  const account = yield* h.request("POST", `${h.prefix}/connections/${connection.id}/submit`, {
    method: "key",
    fields: { token: "synthetic-only" },
  });
  const jobs = [`${pool.id}-retained-failure`, `${pool.id}-delayed-running`];
  yield* h.control("storage/legacy", {
    database: "product",
    statements: [
      { sql: "ALTER TABLE hosted_contributed_departure_jobs DROP COLUMN queued_at" },
      { sql: "ALTER TABLE hosted_contributed_departure_jobs DROP COLUMN last_error" },
      { sql: "DELETE FROM private_hosted_migrations WHERE migration_id = 13" },
      {
        sql: "INSERT INTO hosted_contributed_departure_jobs (id, organization_id, user_id, status, attempts, updated_at) VALUES ($1, $3, $4, 'failed', 8, now() - interval '10 minutes'), ($2, $3, $4, 'running', 1, now() - interval '6 minutes')",
        params: [...jobs, h.actors.organization.id, "synthetic-departed-person"],
      },
      ...jobs.map((job, index) => ({
        sql: "INSERT INTO hosted_contributed_departures (job, app, requirement, account, linked_at) SELECT $1, app, requirement, account, created_at FROM hosted_app_account_links WHERE app = $2 AND account = $3 AND subject IS NULL",
        params: [
          job,
          index === 0 ? pool.id : delayedPool.id,
          index === 0 ? account.id : delayedAccount.id,
        ],
      })),
    ],
  });
  yield* h.control("start");
  const page = yield* h.request("GET", `${h.appPath(pool.id)}/accounts/departures`);
  checked(
    "normal product API exposes the retained failed cleanup",
    page.items.map((item) => item.status).sort(),
    ["failed"],
  );
  checked(
    "migration leaves historical diagnostics unknown",
    page.items.every((item) => item.queuedAt === null && item.lastError === null),
    true,
  );
  const source = JSON.parse(
    yield* Effect.promise(() =>
      readFile(join(root, "src/catalog/recipes/pool-owner.json"), "utf8"),
    ),
  );
  const config = `export const configuration = ${JSON.stringify({
    organization: h.actors.organization.id,
    accounts: [],
    pools: [
      { app: pool.id, provider: "codex" },
      { app: pool.id, provider: "claude" },
      { app: delayedPool.id, provider: "codex" },
    ],
    operator: {
      release: null,
      availability: null,
      workflowApps: [],
      runtime: null,
      httpErrors: null,
      errorCounts: null,
    },
  })};`;
  const files = (negative = false) =>
    source.files
      .filter((file) => file.path !== "package.json")
      .map((file) => ({
        ...file,
        content:
          file.path === "common/configuration.ts"
            ? config
            : file.path === "common/installation.ts"
              ? file.content.replace('"https://app.signalbox.run"', JSON.stringify(h.origin))
              : negative && file.path === "pool-owner/departures.ts"
                ? file.content.replace(
                    /const actionable = rows\.filter\([\s\S]+?\n    \);/,
                    "const actionable: typeof rows = [];",
                  )
                : file.content,
      }));
  const key = yield* h.request("POST", "/api/auth/api-key/create", {
    name: "Synthetic departure workflow",
  });
  const makeCopy = (name, negative = false) =>
    Effect.gen(function* () {
      const copy = yield* deploy(name, files(negative));
      yield* h.connect(copy.id, "service", {
        token: key.key,
        organization: h.actors.organization.id,
      });
      yield* h.approved(copy.id, "configure", { deliveryEnabled: true });
      return copy;
    });
  const copy = yield* makeCopy("Synthetic private departure checks");
  const checkpoint = (app = copy) => h.call(app.id, "checkpoint", { key: `departures:${pool.id}` });
  let tick = 0;
  const scan = (app = copy, target = pool.id) =>
    h.request("POST", `${h.appPath(app.id)}/workflow-runs`, {
      workflow: "checkContributedDepartures",
      input: { target, tick: tick++ },
    });
  yield* scan();
  const waiting = yield* until(
    checkpoint(),
    (value) => value.question !== undefined,
    "real departure state did not create a native human question",
  );
  checked(
    "the native workflow finds a terminal failure without any delayed job",
    waiting.observation.code,
    "departure-cleanup-needs-attention",
  );
  checked("the question contains the affected link", waiting.observation.details.length, 1);
  const question = yield* h.request(
    "GET",
    `${h.appPath(copy.id)}/workflow-inputs/${waiting.question.id}`,
  );
  const evidence = JSON.stringify(question.evidence);
  checked(
    "evidence retains pool, account, job and attempt identifiers",
    [pool.name, account.id, jobs[0], "attempt 8"].every((value) => evidence.includes(value)),
    true,
  );
  checked(
    "evidence labels the unknown historical error",
    evidence.includes("Last error: not recorded"),
    true,
  );
  checked(
    "only allowlisted diagnostics reach the human question",
    evidence.includes("synthetic-only"),
    false,
  );
  checked(
    "the default destination retains the question without an external message",
    [waiting.open, fixture.sends.length],
    [true, 0],
  );
  yield* scan(copy, delayedPool.id);
  const delayed = yield* until(
    h.call(copy.id, "checkpoint", { key: `departures:${delayedPool.id}` }),
    (value) => value.question !== undefined,
    "a delayed running job alone did not create a human question",
  );
  checked(
    "a running job delayed five minutes independently needs attention",
    delayed.observation.code,
    "departure-cleanup-needs-attention",
  );
  checked(
    "delayed cleanup uses its own pool and account evidence",
    delayed.observation.details[0].value.includes(delayedAccount.id) &&
      delayed.observation.details[0].value.includes(jobs[1]),
    true,
  );
  yield* scan();
  yield* until(
    h.request("GET", `${h.appPath(copy.id)}/workflow-runs`),
    (value) => value.items.some((run) => run.output?.status === "approvals-only"),
    "repeat scan did not finish without duplicate delivery",
  );
  checked(
    "repeat scans retain the same native question",
    (yield* checkpoint()).question.id,
    waiting.question.id,
  );
  const scheduled = yield* h.call(copy.id, "departureTick", {}, "mutation");
  checked(
    "the departure schedule checks each app once across provider groups",
    scheduled.started,
    2,
  );
  const damagedFiles = files(true);
  assert.notEqual(
    damagedFiles.find((file) => file.path === "pool-owner/departures.ts").content,
    files().find((file) => file.path === "pool-owner/departures.ts").content,
  );
  const damaged = yield* makeCopy("Synthetic suppressed-departure negative control", true);
  const run = yield* scan(damaged);
  yield* until(
    h.request("GET", `${h.appPath(damaged.id)}/workflow-runs/${run.id}`),
    (value) => value.status === "complete",
    "negative control did not finish",
  );
  const suppressed = yield* checkpoint(damaged);
  let negativeControl;
  try {
    assert.equal(suppressed.open, true, "a failed departure must need human input");
  } catch (error) {
    negativeControl = { code: error.code, actual: error.actual, expected: error.expected };
  }
  checked("the consumer proof rejects a suppressed departure condition", negativeControl, {
    code: "ERR_ASSERTION",
    actual: false,
    expected: true,
  });
  yield* h.request("DELETE", h.appPath(pool.id));
  yield* scan();
  const withdrawn = yield* until(
    h.request("GET", `${h.appPath(copy.id)}/workflow-inputs/${waiting.question.id}`),
    (value) => value.status === "withdrawn",
    "removing the source app did not withdraw its obsolete human question",
  );
  checked("source removal withdraws the existing question", withdrawn.status, "withdrawn");
  checked("no departure trial sends an external message", fixture.sends.length, 0);
  return {
    checks,
    negativeControl,
    runtimeDirectory: h.runtimeDirectory,
    syntheticMessagesOnly: true,
  };
});
try {
  const report = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(runtime)));
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify({ checks: checks.length, directory }));
} catch (error) {
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  await writeFile(join(directory, "partial-checks.json"), JSON.stringify(checks, null, 2), {
    mode: 0o600,
  });
  console.error("Departure recipe proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
