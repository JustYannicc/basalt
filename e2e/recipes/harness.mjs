import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { Effect, Layer, Context, Redacted, Schedule } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../../.upstream/e2e/support/managed-server.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { appsManifest } from "../../.upstream/e2e/support/apps-release.ts";
import { provisionSelfHostActors } from "../../scripts/connectors-tests/test-accounts.mjs";

export const root = resolve(import.meta.dirname, "../..");
export { appsManifest };
export const runtime = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
/** Poll only persisted public milestones, with a bounded deadline. */
export const until = (read, predicate, label) =>
  read.pipe(
    Effect.flatMap((value) => (predicate(value) ? Effect.succeed(value) : Effect.fail(label))),
    Effect.retry({ schedule: Schedule.spaced("25 millis"), times: 600 }),
  );

export const recipeHarness = (directory, fixtureOrigin) =>
  Effect.gen(function* () {
    const base = yield* startEnvironment({ target: "self-host", headless: true });
    const registry = yield* lockedNpmRegistry;
    const prepared = yield* prepareScenario(base.target, "Private check recipe public path");
    const authSecret = randomBytes(32).toString("hex");
    const actors = yield* Effect.promise(() =>
      provisionSelfHostActors({
        executable: process.execPath,
        upstream: join(root, ".upstream"),
        target: prepared,
        authSecret,
        directory,
      }),
    );
    const server = yield* startManagedServer(prepared, "product", {
      BETTER_AUTH_SECRET: authSecret,
      EXECUTOR_PRODUCT_NAME: "Signalbox",
      EXECUTOR_NPM_REGISTRY: registry.url,
      EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
      EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([fixtureOrigin]),
    });
    const target = Target.of({
      ...prepared,
      controlOrigin: server.controlOrigin,
      metadata: { ...prepared.metadata, origin: server.origin },
    });
    const services = yield* Layer.build(
      SessionClients.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))),
    );
    const api = Context.get(services, SessionClients);
    const session = yield* api.session(Redacted.make(actors.owner.cookies));
    const request = (method, path, input) =>
      api.request(session, method, path, input).pipe(
        Effect.map((response) => {
          assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
          return response.body;
        }),
      );
    const prefix = `/api/organizations/${actors.organization.id}`;
    const appPath = (id) => `${prefix}/apps/${id}`;
    const call = (id, tool, input = {}, kind = "query") =>
      request("POST", `${appPath(id)}/tools/call`, { tool, input, kind });
    const approveResult = (id, tool, input) =>
      Effect.gen(function* () {
        const path = `${appPath(id)}/tools`;
        const run = yield* request("POST", `${path}/run`, { tool, input, kind: "mutation" });
        if (run.status === "completed") return run;
        assert.equal(run.status, "approval-required");
        const answer = yield* request("POST", `${path}/approvals/${run.requestId}`, {
          response: { action: "accept", content: {} },
        });
        return answer.result;
      });
    const approved = (id, tool, input) =>
      approveResult(id, tool, input).pipe(
        Effect.map((result) => {
          assert.equal(result?.status, "completed", JSON.stringify(result));
          return result.value;
        }),
      );
    const connect = (id, slot, fields) =>
      Effect.gen(function* () {
        const connection = yield* request(
          "POST",
          `${appPath(id)}/accounts/user/${slot}/connections`,
          {},
        );
        return yield* request("POST", `${prefix}/connections/${connection.id}/submit`, {
          method: "apiKey",
          fields,
        });
      });
    const control = (action) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${server.controlOrigin}/${action}`, {
            method: "POST",
            headers: { authorization: `Bearer ${Redacted.value(prepared.apiKey)}` },
          });
          assert.equal(response.status, 200, `Control ${action}: ${await response.text()}`);
        },
        catch: (error) => error,
      });
    // The crashed process's PGlite heartbeat lock expires after about ten seconds.
    const restartAfterCrash = control("start").pipe(
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: 20 }),
    );
    return {
      actors,
      prefix,
      origin: server.origin,
      request,
      appPath,
      call,
      approved,
      approveResult,
      connect,
      control,
      restartAfterCrash,
      runtimeDirectory: prepared.directory,
    };
  });
