import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { appsManifest, root, until } from "./harness.mjs";

/** Two native workflows in one copy keep their own destination and quiet hours across source edits. */
export const verifyWorkflowIsolation = ({
  h,
  deploy,
  fixture,
  checked,
  managementKey,
  directory,
}) =>
  Effect.gen(function* () {
    const source = JSON.parse(
      yield* Effect.promise(() =>
        readFile(join(root, "src/catalog/recipes/operator.json"), "utf8"),
      ),
    );
    const channel = (name) =>
      deploy(`Synthetic ${name} destination`, [
        {
          path: "index.ts",
          content: `
import { defineApp, mutation, object, string, router, decodeJson, json } from "apps";
import { never } from "apps/operations/approval";
const send = mutation({ approval: never(), input: object({ message: string(), reviewUrl: string() }) }, async (ctx, input) =>
  decodeJson(await ctx.fetch(${JSON.stringify(`${fixture.origin}/send`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, destination: ${JSON.stringify(name)} }), signal: ctx.signal }), json()));
export default defineApp({}, { tools: router({ send }) });`,
        },
      ]);
    const a = yield* channel("workflow-A"),
      b = yield* channel("workflow-B");
    const metrics = yield* deploy("Synthetic workflow metrics", [
      {
        path: "index.ts",
        content: `
import { defineApp, query, object, router } from "apps";
const release = query({ input: object({}) }, async () => ({ workflow_runs: [{ id: 101, workflow_id: 42, run_attempt: 1, head_branch: "main", status: "completed", conclusion: "failure", created_at: new Date(Date.now()-20000).toISOString(), updated_at: new Date(Date.now()-10000).toISOString() }] }));
const runtime = query({ input: object({}) }, async () => ({ at: Date.now()-1000, startedAt: Date.now()-240000, boot: "synthetic-boot", ready: false, unexpectedBoots: [], excludesExpectedRestarts: true }));
export default defineApp({}, { tools: router({ release, runtime }) });`,
      },
    ]);
    const config = `export const configuration = ${JSON.stringify({
      organization: h.actors.organization.id,
      accounts: [],
      pools: [],
      operator: {
        release: {
          app: metrics.id,
          tool: "release",
          input: {},
          workflowId: 42,
          branch: "main",
          repository: "synthetic/workflow",
        },
        runtime: { app: metrics.id, tool: "runtime", input: {} },
        availability: null,
        workflowApps: [],
        httpErrors: null,
        errorCounts: null,
      },
    })};`;
    const hour = new Date().getUTCHours();
    const quiet = { timezone: "UTC", startHour: hour, endHour: (hour + 1) % 24 };
    const fields = (hours, humanOnly = false) => `
Object.assign(workflowFields, {
  checkProductionRelease: { destination: ${humanOnly ? '{ kind: "approvals" }' : `{ kind: "tool", app: ${JSON.stringify(a.id)}, tool: "send", input: (message, reviewUrl) => ({ message, reviewUrl }), receipt: value => value.receipt }`}, quietHours: null },
  checkPoolRuntime: { destination: ${humanOnly ? '{ kind: "approvals" }' : `{ kind: "tool", app: ${JSON.stringify(b.id)}, tool: "send", input: (message, reviewUrl) => ({ message, reviewUrl }), receipt: value => value.receipt }`}, quietHours: ${JSON.stringify(hours)} }
});`;
    const files = (hours, humanOnly = false) =>
      source.files
        .filter((file) => file.path !== "package.json")
        .map((file) => ({
          ...file,
          content:
            file.path === "common/configuration.ts"
              ? config
              : file.path === "common/workflow-fields.ts"
                ? file.content + fields(hours, humanOnly)
                : file.path === "common/installation.ts"
                  ? file.content.replace('"https://app.signalbox.run"', JSON.stringify(h.origin))
                  : file.content,
        }));
    const connect = (copy) =>
      h.connect(copy.id, "service", {
        token: managementKey,
        organization: h.actors.organization.id,
      });
    let tick = 0;
    const scan = (copy, workflow) =>
      h.request("POST", `${h.appPath(copy.id)}/workflow-runs`, {
        workflow,
        input: { target: workflow, tick: tick++ },
      });
    const state = (copy, workflow) =>
      h.call(copy.id, "checkpoint", { key: `production:${workflow}` });
    const count = (name) => fixture.sends.filter((send) => send.destination === name).length;
    const copy = yield* deploy("Synthetic independent workflow fields", files(quiet));
    yield* connect(copy);
    yield* h.approved(copy.id, "configure", { deliveryEnabled: true });
    const releaseRun = yield* scan(copy, "checkProductionRelease");
    yield* scan(copy, "checkPoolRuntime");
    const release = yield* until(
      state(copy, "checkProductionRelease"),
      (value) => value.notified === "sent",
      "first workflow did not use its own channel",
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const stateValue = yield* state(copy, "checkProductionRelease");
          const run = yield* h.request(
            "GET",
            `${h.appPath(copy.id)}/workflow-runs/${releaseRun.id}`,
          );
          yield* Effect.promise(() =>
            writeFile(
              join(directory, "isolation-first-run.json"),
              JSON.stringify({ state: stateValue, run }, null, 2),
              { mode: 0o600 },
            ),
          );
          return yield* Effect.fail(error);
        }),
      ),
    );
    const runtime = yield* until(
      state(copy, "checkPoolRuntime"),
      (value) => value.question !== undefined,
      "quiet workflow lost its Human in the loop item",
    );
    checked(
      "first workflow uses only destination A",
      [count("workflow-A"), count("workflow-B")],
      [1, 0],
    );
    checked(
      "quiet hours leave the second workflow pending without an external send",
      [runtime.open, runtime.notified],
      [true, "none"],
    );
    yield* h.request("POST", `${h.appPath(copy.id)}/deploy`, {
      files: [...files(null), appsManifest],
    });
    const unconfigured = yield* scan(copy, "checkPoolRuntime");
    const stopped = yield* until(
      h.request("GET", `${h.appPath(copy.id)}/workflow-runs/${unconfigured.id}`),
      (value) => value.status === "complete",
      "changed workflow ran without renewed consent",
    );
    checked(
      "a workflow edit requires renewed copy consent",
      stopped.output.code,
      "configuration-changed",
    );
    yield* h.approved(copy.id, "configure", { deliveryEnabled: true });
    yield* scan(copy, "checkPoolRuntime");
    const unquiet = yield* until(
      state(copy, "checkPoolRuntime"),
      (value) => value.notified === "sent",
      "removing one workflow's quiet hours did not use destination B",
    );
    checked(
      "changing one workflow's quiet hours keeps the other's channel receipt",
      [count("workflow-A"), count("workflow-B")],
      [1, 1],
    );
    checked(
      "the quiet-hours edit retains the original second question",
      unquiet.question.id,
      runtime.question.id,
    );
    checked(
      "the unrelated workflow keeps its question and receipt",
      (yield* state(copy, "checkProductionRelease")).question.id,
      release.question.id,
    );
    yield* h.request("POST", `${h.appPath(copy.id)}/workflow-inputs/${release.question.id}`, {
      response: { action: "accept", content: { action: "recheck" } },
    });
    const retained = yield* until(
      h.request("GET", `${h.appPath(copy.id)}/workflow-runs/${releaseRun.id}`),
      (value) => value.status === "complete",
      "retained workflow did not finish after the answer",
    );
    checked(
      "an older run cannot inherit consent for edited workflow fields",
      retained.output.status,
      "configuration-changed",
    );
    checked(
      "answering the retained run does not send again",
      [count("workflow-A"), count("workflow-B")],
      [1, 1],
    );
    const humanOnly = yield* deploy("Synthetic Human in the loop only", files(null, true));
    yield* connect(humanOnly);
    yield* h.approved(humanOnly.id, "configure", { deliveryEnabled: true });
    for (const workflow of ["checkProductionRelease", "checkPoolRuntime"]) {
      yield* scan(humanOnly, workflow);
      const pending = yield* until(
        state(humanOnly, workflow),
        (value) => value.question !== undefined,
        "Human in the loop destination did not retain its question",
      );
      checked(
        `${workflow} supports Human in the loop without a channel`,
        [pending.open, pending.notified],
        [true, "none"],
      );
    }
    checked(
      "Human in the loop destinations send no external messages",
      [count("workflow-A"), count("workflow-B")],
      [1, 1],
    );
  });
