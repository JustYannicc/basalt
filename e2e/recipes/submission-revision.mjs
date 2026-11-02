import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { appsManifest, root, until } from "./harness.mjs";

/** Reconfigure through public APIs while the old send callback waits after its consent preflight. */
export const verifySubmissionRevision = ({
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
      deploy(`Synthetic ${name} consent race`, [
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
    const a = yield* channel("race-A"),
      b = yield* channel("race-B");
    const metrics = yield* deploy("Synthetic blocked release read", [
      {
        path: "index.ts",
        content: `
import { defineApp, query, object, router, decodeJson, json } from "apps";
const release = query({ input: object({}) }, async (ctx) => {
  await decodeJson(await ctx.fetch(${JSON.stringify(`${fixture.origin}/health`)}, { signal: ctx.signal, headers: { "x-fixture-account": "submission-revision-race" } }), json());
  return { workflow_runs: [{ id: 202, workflow_id: 42, run_attempt: 1, head_branch: "main", status: "completed", conclusion: "failure", created_at: new Date(Date.now()-20000).toISOString(), updated_at: new Date(Date.now()-10000).toISOString() }] };
});
export default defineApp({}, { tools: router({ release }) });`,
      },
    ]);
    const configuration = `export const configuration = ${JSON.stringify({ organization: h.actors.organization.id, accounts: [], pools: [], operator: { release: { app: metrics.id, tool: "release", input: {}, workflowId: 42, branch: "main", repository: "synthetic/workflow" }, runtime: null, availability: null, workflowApps: [], httpErrors: null, errorCounts: null } })};`;
    const files = (destination) =>
      source.files
        .filter((file) => file.path !== "package.json")
        .map((file) => ({
          ...file,
          content:
            file.path === "common/configuration.ts"
              ? configuration
              : file.path === "common/workflow-fields.ts"
                ? file.content +
                  `\nworkflowFields.checkProductionRelease = { destination: { kind: "tool", app: ${JSON.stringify(destination)}, tool: "send", input: (message, reviewUrl) => ({ message, reviewUrl }), receipt: value => value.receipt }, quietHours: null };`
                : file.path === "common/installation.ts"
                  ? file.content.replace('"https://app.signalbox.run"', JSON.stringify(h.origin))
                  : file.content,
        }));
    const copy = yield* deploy("Synthetic retained submission consent", files(a.id));
    yield* h.connect(copy.id, "service", {
      token: managementKey,
      organization: h.actors.organization.id,
    });
    const originalConsent = yield* h.approved(copy.id, "configure", { deliveryEnabled: true });
    const checkpoint = () =>
      h.call(copy.id, "checkpoint", { key: "production:checkProductionRelease" });
    // Initial observation, nudge recheck, then the send callback's post-preflight recheck.
    const blocked = fixture.holdHealth("submission-revision-race", 3);
    yield* h.request("POST", `${h.appPath(copy.id)}/workflow-runs`, {
      workflow: "checkProductionRelease",
      input: { target: "checkProductionRelease", tick: 0 },
    });
    yield* Effect.promise(() => blocked).pipe(Effect.timeout("15 seconds"));
    const claimed = yield* checkpoint();
    checked(
      "the consent race reaches the actual callback after preflight",
      claimed.notified,
      "claimed",
    );
    yield* h.request("POST", `${h.appPath(copy.id)}/deploy`, {
      files: [...files(b.id), appsManifest],
    });
    const changedConsent = yield* h.approved(copy.id, "configure", { deliveryEnabled: true });
    checked(
      "the destination edit approves a different configuration revision",
      changedConsent.revision !== originalConsent.revision,
      true,
    );
    fixture.releaseHealth();
    const finished = yield* until(
      Effect.suspend(checkpoint),
      (value) => ["sent", "refused", "uncertain"].includes(value.notified),
      "the resumed old callback did not record its delivery outcome",
    );
    const sends = fixture.sends.filter((send) => ["race-A", "race-B"].includes(send.destination));
    yield* Effect.promise(() =>
      writeFile(
        join(directory, "submission-revision-race.json"),
        JSON.stringify(
          {
            originalRevision: originalConsent.revision,
            changedRevision: changedConsent.revision,
            outcome: finished.notified,
            submittedDestinations: sends.map((send) => send.destination),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      ),
    );
    checked(
      "new consent cannot authorize the old callback's destination after preflight",
      sends.length,
      0,
    );
    checked(
      "a revision mismatch is a known refusal before submission",
      finished.notified,
      "refused",
    );
    checked(
      "the blocked old callback retains its human question",
      finished.question.id,
      claimed.question.id,
    );
    yield* h.approved(copy.id, "retryRefusedDelivery", {
      key: "production:checkProductionRelease",
    });
    yield* h.request("POST", `${h.appPath(copy.id)}/workflow-runs`, {
      workflow: "checkProductionRelease",
      input: { target: "checkProductionRelease", tick: 1 },
    });
    yield* until(
      Effect.suspend(checkpoint),
      (value) => value.notified === "sent",
      "current consent did not permit the approved safe retry",
    );
    checked(
      "an approved retry uses only the new destination",
      fixture.sends
        .filter((send) => ["race-A", "race-B"].includes(send.destination))
        .map((send) => send.destination),
      ["race-B"],
    );
  });
