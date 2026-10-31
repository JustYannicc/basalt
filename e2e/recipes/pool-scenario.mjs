import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { appsManifest, root, until } from "./harness.mjs";

/** Normal public deployment, connections and approvals shared by the pool journeys. */
export const poolRecipeScenario = (h, pool) =>
  Effect.gen(function* () {
    const fixture = h.fixture;
    const deployAs = (role, name, files) =>
      h.requestAs(role, "POST", `${h.prefix}/apps/deploy`, {
        name,
        files: [...files, appsManifest],
      });
    const channelFiles = [
      {
        path: "index.ts",
        content: `
import { defineApp, mutation, query, object, string, router, decodeJson, json } from "apps";
import { never } from "apps/operations/approval";
const probe = query({ input: object({}) }, async () => true);
const send = mutation({ approval: never(), input: object({ message: string(), reviewUrl: string() }) }, async (ctx, input) =>
  decodeJson(await ctx.fetch(${JSON.stringify(`${fixture.origin}/send`)}, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: ctx.signal }), json()));
export default defineApp({}, { tools: router({ probe, send }) });`,
      },
    ];
    const channel = yield* deployAs("owner", "Synthetic pool nudge channel", channelFiles);
    let copyNumber = 0;
    const copy = (role, channel, transform = (file) => file) =>
      Effect.gen(function* () {
        const source = JSON.parse(
          yield* Effect.promise(() =>
            readFile(join(root, "src/catalog/recipes/pool-owner.json"), "utf8"),
          ),
        );
        const config = `export const configuration = {
      organization: ${JSON.stringify(h.actors.organization.id)}, accounts: [], pools: [{ app: ${JSON.stringify(pool.id)}, provider: "codex" }], quietHours: null,
      channel: { app: ${JSON.stringify(channel.id)}, tool: "send", input: (message, reviewUrl) => ({ message, reviewUrl }), receipt: (value) => value.receipt },
      operator: { release: null, availability: null, workflowApps: [], runtime: null, httpErrors: null, errorCounts: null }
    };`;
        const app = yield* deployAs(
          role,
          `Synthetic private pool checks ${++copyNumber}`,
          source.files
            .filter((file) => file.path !== "package.json")
            .map((file) => ({
              ...file,
              content:
                file.path === "common/configuration.ts"
                  ? config
                  : file.path === "common/installation.ts"
                    ? file.content.replace('"https://app.signalbox.run"', JSON.stringify(h.origin))
                    : file.content,
            }))
            .map(transform),
        );
        const key = yield* h.requestAs(role, "POST", "/api/auth/api-key/create", {
          name: "Synthetic pool recipe",
        });
        yield* h.connectAs(role, app.id, "service", {
          token: key.key,
          organization: h.actors.organization.id,
        });
        yield* h.approvedAs(role, app.id, "configure", { deliveryEnabled: false });
        return app;
      });
    const share = (role, app, kind) =>
      Effect.gen(function* () {
        const access = yield* h.requestAs(role, "GET", `${h.appPath(app.id)}/access`);
        return yield* h.requestAs(role, "PATCH", `${h.appPath(app.id)}/access`, {
          revision: access.revision,
          audience: { kind },
        });
      });
    let tick = 0;
    const key = `pool:${pool.id}:codex`;
    const checkpoint = (app, role = "owner") => h.callAs(role, app.id, "checkpoint", { key });
    const scan = (app, role = "owner") =>
      h.requestAs(role, "POST", `${h.appPath(app.id)}/workflow-runs`, {
        workflow: "checkMyPool",
        input: { target: `${pool.id}:codex`, tick: tick++ },
      });
    const finish = (app, run, role = "owner") =>
      until(
        h.requestAs(role, "GET", `${h.appPath(app.id)}/workflow-runs/${run.id}`),
        (value) => ["complete", "errored", "terminated"].includes(value.status),
        "pool scan did not finish",
      ).pipe(
        Effect.map((value) => {
          assert.equal(value.status, "complete", JSON.stringify(value));
          return value;
        }),
      );
    const read = (app, role = "owner") =>
      Effect.gen(function* () {
        return yield* finish(app, yield* scan(app, role), role);
      });
    const healthy = (app, id) =>
      Effect.gen(function* () {
        for (let count = 0; count < 2; count++) {
          fixture.seed(pool.id, id);
          yield* read(app);
        }
      });
    return {
      fixture,
      channel,
      channelFiles,
      deployAs,
      copy,
      share,
      key,
      checkpoint,
      scan,
      read,
      healthy,
    };
  });
