import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { root, until } from "./harness.mjs";

/** A real refused connector call must reach a separate watching recipe through public health. */
export const verifyWatchingWorkflow = ({
  h,
  deploy,
  fixture,
  checked,
  account,
  channel,
  managementKey,
}) =>
  Effect.gen(function* () {
    const copy = (role, configuration) =>
      Effect.gen(function* () {
        const source = JSON.parse(
          yield* Effect.promise(() =>
            readFile(join(root, `src/catalog/recipes/${role}.json`), "utf8"),
          ),
        );
        const app = yield* deploy(
          `Synthetic ${role} workflow watch`,
          source.files
            .filter((file) => file.path !== "package.json")
            .map((file) => ({
              ...file,
              content:
                file.path === "common/configuration.ts"
                  ? configuration
                  : file.path === "common/installation.ts"
                    ? file.content.replace('"https://app.signalbox.run"', JSON.stringify(h.origin))
                    : file.content,
            })),
        );
        yield* h.connect(app.id, "service", {
          token: managementKey,
          organization: h.actors.organization.id,
        });
        yield* h.approved(app.id, "configure", { deliveryEnabled: true });
        return app;
      });
    const base = {
      organization: h.actors.organization.id,
      accounts: [account.id],
      pools: [],
      quietHours: null,
      operator: {
        release: null,
        availability: null,
        workflowApps: [],
        runtime: null,
        httpErrors: null,
        errorCounts: null,
      },
    };
    const configuration = (app, workflowApps = []) =>
      `export const configuration = { ...${JSON.stringify(base)},
        channel: { app: ${JSON.stringify(app)}, tool: "send", input: (message, reviewUrl) => ({ message, reviewUrl }), receipt: (value) => value.receipt },
        operator: ${JSON.stringify({ ...base.operator, workflowApps })} };`;
    const refusedChannel = yield* deploy("Synthetic protected delivery channel", [
      {
        path: "index.ts",
        content: `
import { defineApp, mutation, object, string, router, decodeJson, json } from "apps";
import { always } from "apps/operations/approval";
const send = mutation({ approval: always(), input: object({ message: string(), reviewUrl: string() }) }, async (ctx, input) =>
  decodeJson(await ctx.fetch(${JSON.stringify(`${fixture.origin}/send`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: ctx.signal }), json()));
export default defineApp({}, { tools: router({ send }) });`,
      },
    ]);
    const watched = yield* copy("personal", configuration(refusedChannel.id));
    fixture.setHealth("rejected");
    const initialSends = fixture.sends.length;
    let tick = 0;
    const scan = (app, workflow, target) =>
      h.request("POST", `${h.appPath(app)}/workflow-runs`, {
        workflow,
        input: { target, tick: tick++ },
      });
    const watchedKey = `account:${account.id}`;
    yield* scan(watched.id, "checkMyConnections", account.id);
    const refusal = yield* until(
      h.call(watched.id, "checkpoint", { key: watchedKey }),
      (value) => value.notified === "refused",
      "protected channel refusal was not persisted",
    );
    checked("protected connector refusal submits no message", fixture.sends.length, initialSends);
    checked(
      "refused delivery still has its original waiting question",
      refusal.question !== undefined,
      true,
    );
    const watcher = yield* copy(
      "operator",
      configuration(channel.id, [
        {
          app: watched.id,
          workflows: [{ name: "checkMyConnections", maximumAgeMinutes: 30 }],
        },
      ]),
    );
    const watcherKey = "production:checkWorkflowHealth";
    const watch = () => scan(watcher.id, "checkWorkflowHealth", "checkWorkflowHealth");
    yield* watch();
    const opening = yield* until(
      h.call(watcher.id, "checkpoint", { key: watcherKey }),
      (value) => value.notified === "sent",
      "watching workflow did not send its nudge",
    );
    checked(
      "watcher opens a native question for the refused delivery",
      opening.observation.code,
      "workflow-check-failed",
    );
    checked(
      "watcher uses the configured synthetic fallback channel once",
      fixture.sends.length,
      initialSends + 1,
    );
    const question = yield* h.request(
      "GET",
      `${h.appPath(watcher.id)}/workflow-inputs/${opening.question.id}`,
    );
    checked(
      "watcher notification links its committed native question",
      fixture.sends.at(-1).reviewUrl,
      question.reviewUrl,
    );
    const duplicate = yield* watch();
    yield* until(
      h.request("GET", `${h.appPath(watcher.id)}/workflow-runs/${duplicate.id}`),
      (value) => value.status === "complete",
      "duplicate watcher did not finish",
    );
    checked(
      "watcher repeats keep one question and one nudge",
      fixture.sends.length,
      initialSends + 1,
    );
    checked(
      "watcher repeats retain the same question",
      (yield* h.call(watcher.id, "checkpoint", { key: watcherKey })).question.id,
      opening.question.id,
    );
    fixture.setHealth("healthy");
    const recovery = yield* scan(watched.id, "checkMyConnections", account.id);
    yield* until(
      h.request("GET", `${h.appPath(watched.id)}/workflow-runs/${recovery.id}`),
      (value) => value.status === "complete",
      "watched recipe did not recover",
    );
    yield* watch();
    const withdrawn = yield* until(
      h.request("GET", `${h.appPath(watcher.id)}/workflow-inputs/${opening.question.id}`),
      (value) => value.status === "withdrawn",
      "watcher did not withdraw after native recovery",
    );
    checked("watcher recovery withdraws its native waiting item", withdrawn.status, "withdrawn");
    checked("watcher recovery stays quiet", fixture.sends.length, initialSends + 1);
  });
