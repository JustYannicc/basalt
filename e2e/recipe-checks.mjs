import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { recipeHarness, runtime, root, appsManifest, until } from "./recipes/harness.mjs";
import { startRecipeUpstream } from "./recipes/upstream.mjs";

const directory = resolve(
  process.argv[2] ?? join(root, ".generated/recipe-checks", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const source = JSON.parse(await readFile(join(root, "src/catalog/recipes/personal.json"), "utf8"));
process.chdir(join(root, ".upstream"));
const checks = [];
const checked = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
const program = Effect.gen(function* () {
  const fixture = yield* Effect.acquireRelease(Effect.promise(startRecipeUpstream), (fixture) =>
    Effect.promise(() => fixture.stop()),
  );
  const h = yield* recipeHarness(directory, fixture.origin);
  const deploy = (name, files) =>
    h.request("POST", `${h.prefix}/apps/deploy`, { name, files: [...files, appsManifest] });
  const resource = yield* deploy("Synthetic monitored account", [
    {
      path: "index.ts",
      content: `
import { defineApp, defineProvider, object, string, secrets, ProviderError, decodeJson, json } from "apps";
const resource = defineProvider({ name: "Synthetic monitored resource", auth: { apiKey: secrets({ label: "Synthetic key", fields: object({ token: string() }) }) },
  async health({ fetch, signal }) { const value = await decodeJson(await fetch(${JSON.stringify(`${fixture.origin}/health`)}, { signal }), json());
    if (value.status === "rejected") throw new ProviderError({ reason: "unauthorized", status: 401 });
    if (value.status === "transient") throw new ProviderError({ reason: "unavailable", status: 429 });
    return {}; }
});
export default defineApp({ user: { accounts: { resource } } }, {});`,
    },
  ]);
  const account = yield* h.connect(resource.id, "resource", { token: "synthetic-key" });
  const channel = yield* deploy("Synthetic connected channel", [
    {
      path: "index.ts",
      content: `
import { defineApp, mutation, object, string, router, decodeJson, json } from "apps";
import { never } from "apps/operations/approval";
const send = mutation({ approval: never(), input: object({ message: string(), reviewUrl: string() }) }, async (ctx, input) =>
  decodeJson(await ctx.fetch(${JSON.stringify(`${fixture.origin}/send`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: ctx.signal }), json()));
export default defineApp({}, { tools: router({ send }) });`,
    },
  ]);
  const configuration = `export const configuration = { organization: ${JSON.stringify(h.actors.organization.id)}, accounts: [${JSON.stringify(account.id)}], pools: [], quietHours: null,
    channel: { app: ${JSON.stringify(channel.id)}, tool: "send", input: (message, reviewUrl) => ({ message, reviewUrl }), receipt: (value) => value.receipt },
    operator: { release: null, availability: null, workflowApps: [], runtime: null, httpErrors: null, errorCounts: null } };`;
  const files = source.files
    .filter((file) => file.path !== "package.json")
    .map((file) => ({
      ...file,
      content:
        file.path === "common/configuration.ts"
          ? configuration
          : file.path === "common/installation.ts"
            ? file.content.replace('"https://app.signalbox.run"', JSON.stringify(h.origin))
            : file.content,
    }));
  const copy = yield* deploy("Private connection checks", files);
  const key = yield* h.request("POST", "/api/auth/api-key/create", {
    name: "Private recipe fixture",
  });
  yield* h.connect(copy.id, "service", { token: key.key, organization: h.actors.organization.id });
  yield* h.approved(copy.id, "configure", { deliveryEnabled: false });
  const checkpoint = () => h.call(copy.id, "checkpoint", { key: `account:${account.id}` });
  let tick = 0;
  const scan = () =>
    h.request("POST", `${h.appPath(copy.id)}/workflow-runs`, {
      workflow: "checkMyConnections",
      input: { target: account.id, tick: tick++ },
    });
  const run = yield* scan();
  const pending = yield* until(
    Effect.suspend(checkpoint),
    (value) => value.question !== undefined,
    "question was not persisted",
  ).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const failed = yield* h.request("GET", `${h.appPath(copy.id)}/workflow-runs/${run.id}`);
        const state = yield* checkpoint();
        yield* Effect.promise(() =>
          writeFile(
            join(directory, "first-run.json"),
            JSON.stringify({ run: failed, state }, null, 2),
            { mode: 0o600 },
          ),
        );
        return yield* Effect.fail(error);
      }),
    ),
  );
  checked("delivery stays off during dry run", fixture.sends.length, 0);
  checked("one durable question belongs to the failed connection", pending.open, true);
  yield* h.approved(copy.id, "configure", { deliveryEnabled: true });
  yield* scan();
  yield* until(
    Effect.suspend(checkpoint),
    (value) => value.notified === "sent",
    "nudge did not retain its receipt",
  );
  checked("connected channel accepted one nudge", fixture.sends.length, 1);
  checked(
    "nudge contains only the fixed message",
    fixture.sends[0].message,
    "A workflow needs your input.",
  );
  yield* scan();
  yield* until(
    h.request("GET", `${h.appPath(copy.id)}/workflow-runs`),
    (page) =>
      page.items.some(
        (value) => value.status === "complete" && value.output?.status === "already-notified",
      ),
    "duplicate scan did not finish",
  );
  checked("duplicate scan keeps one nudge", fixture.sends.length, 1);
  fixture.setHealth("healthy");
  yield* scan();
  yield* until(
    Effect.suspend(checkpoint),
    (value) => !value.open,
    "healthy check did not withdraw the question",
  );
  const question = yield* h.request(
    "GET",
    `${h.appPath(copy.id)}/workflow-inputs/${pending.question.id}`,
  );
  checked("recovery withdraws the waiting question", question.status, "withdrawn");
  const finished = yield* until(
    h.request("GET", `${h.appPath(copy.id)}/workflow-runs/${run.id}`),
    (value) => value.status === "complete",
    "withdrawn workflow did not finish",
  );
  checked(
    "saved waiting result stays distinct from a repaired resource",
    finished.output.status,
    "withdrawn",
  );
  fixture.setHealth("transient");
  yield* scan();
  yield* until(
    Effect.suspend(checkpoint),
    (value) => value.observation.code === "connection-unknown",
    "temporary refusal was not checked",
  );
  checked("temporary 429 opens no question", (yield* checkpoint()).open, false);
  checked("temporary 429 sends nothing", fixture.sends.length, 1);
  fixture.setHealth("rejected");
  const accepted = fixture.holdNext();
  yield* scan();
  yield* Effect.promise(() => accepted).pipe(Effect.timeout("15 seconds"));
  checked("second episode reaches its channel once", fixture.sends.length, 2);
  const submitted = yield* checkpoint();
  const refused = yield* Effect.all(
    [1, 2].map(() =>
      h.call(
        copy.id,
        "beginDelivery",
        {
          key: `account:${account.id}`,
          episode: submitted.episode,
          question: submitted.question.id,
        },
        "mutation",
      ),
    ),
    { concurrency: 2 },
  );
  checked("concurrent callback attempts cannot reacquire a submitted send", refused, [
    false,
    false,
  ]);
  yield* h.control("kill");
  fixture.release();
  yield* h.restartAfterCrash;
  const interrupted = yield* until(
    Effect.suspend(checkpoint),
    (value) => ["submitted", "uncertain"].includes(value.notified),
    "interrupted send lost its claim",
  );
  checked(
    "interrupted send retains its claim",
    ["submitted", "uncertain"].includes(interrupted.notified),
    true,
  );
  const nextScan = yield* scan();
  yield* until(
    h.request("GET", `${h.appPath(copy.id)}/workflow-runs/${nextScan.id}`),
    (value) => value.status === "complete" && value.output?.status === "already-notified",
    "post-restart scan did not finish",
  );
  checked("lost reply and restart cannot send again", fixture.sends.length, 2);
  const health = yield* h.call(copy.id, "deliveryHealth");
  checked(
    "workflow health sees the unresolved send during the human wait",
    health.deliveries.some((value) => ["submitted", "uncertain"].includes(value.status)),
    true,
  );
  return { checks, syntheticMessagesOnly: true, runtimeDirectory: h.runtimeDirectory };
});
try {
  const result = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(runtime)));
  await writeFile(join(directory, "report.json"), JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify({ checks: checks.length, directory }));
} catch (error) {
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  await writeFile(join(directory, "partial-checks.json"), JSON.stringify(checks, null, 2), {
    mode: 0o600,
  });
  console.error("Recipe proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
