import assert from "node:assert/strict";
import { startSlackHealthFixture } from "./slack-upstream.mjs";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Effect, Layer, Context, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../.upstream/e2e/sdk/scenario.ts";
import { startManagedServer } from "../.upstream/e2e/support/managed-server.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../.upstream/e2e/support/npm-registry.ts";
import { appsManifest } from "../.upstream/e2e/support/apps-release.ts";
import { provisionSelfHostActors } from "../scripts/connectors-tests/test-accounts.mjs";

const root = resolve(import.meta.dirname, "..");
const upstream = join(root, ".upstream");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/slack-health", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const snapshotBytes = await readFile(join(root, "src/catalog/slack.json"));
const snapshot = JSON.parse(snapshotBytes);
const beforeBytes = process.argv[3] ? await readFile(resolve(process.argv[3])) : snapshotBytes;
const before = JSON.parse(beforeBytes);
process.chdir(upstream);
const results = [];
const record = (name, actual, expected) => {
  const passed = isDeepStrictEqual(actual, expected);
  results.push({ name, actual, expected, passed });
};
let answer = { kind: "success" };
const calls = [];
const program = Effect.gen(function* () {
  const fixture = yield* Effect.acquireRelease(
    Effect.promise(() => startSlackHealthFixture(() => answer, calls)),
    (fixture) => Effect.promise(fixture.stop),
  );
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(base.target, "Slack account health and identity");
  const authSecret = randomBytes(32).toString("hex");
  const actors = yield* Effect.promise(() =>
    provisionSelfHostActors({
      executable: process.execPath,
      upstream,
      target: prepared,
      authSecret,
      directory,
    }),
  );
  const server = yield* startManagedServer(prepared, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_URL_ALLOW_LOOPBACK_HTTP: "true",
    EXECUTOR_URL_ALLOW_HTTP_ORIGINS: JSON.stringify([fixture.origin]),
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
  const request = (method, path, data) =>
    Effect.map(
      api
        .request(session, method, path, data)
        .pipe(
          Effect.tapError((error) =>
            Effect.promise(() =>
              writeFile(
                join(directory, "request-failure.json"),
                JSON.stringify({
                  method,
                  path,
                  reason: error.reason,
                  status: error.status,
                  response: error.response,
                }),
                { mode: 0o600 },
              ),
            ),
          ),
        ),
      (response) => {
        assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(response.body)}`);
        return response.body;
      },
    );
  const prefix = `/api/organizations/${actors.organization.id}`;
  // Substitute only the upstream origin so the actual catalog package runs against metadata fixtures.
  const localFiles = (source) =>
    source.files
      .filter((f) => f.path !== "package.json")
      .map((f) => ({
        ...f,
        content: f.content
          .replaceAll("https://slack.com", fixture.origin)
          .replaceAll(
            'hosts: ["slack.com"]',
            `hosts: [${JSON.stringify(new URL(fixture.origin).host)}]`,
          ),
      }));
  const files = [...localFiles(snapshot), appsManifest];
  const beforeFiles = [...localFiles(before), appsManifest];
  const app = yield* request("POST", `${prefix}/apps/deploy`, {
    name: "Slack health proof",
    files: beforeFiles,
  });
  const appPath = `${prefix}/apps/${app.id}`;
  const provider = app.requirements.accounts.slack.provider;
  const ids = [];
  for (const token of ["synthetic-one", "synthetic-two"]) {
    const connection = yield* request("POST", `${appPath}/accounts/user/slack/connections`, {});
    const signIn = yield* request("POST", `${prefix}/connections/${connection.id}/oauth/start`, {
      method: "user",
      label: token,
      client: { clientId: "synthetic-client", clientSecret: "synthetic-secret" },
    });
    const authorization = new URL(signIn.authorizationUrl);
    authorization.searchParams.set("fixture_user", token);
    const consent = yield* Effect.promise(() => fetch(authorization, { redirect: "manual" }));
    assert.equal(consent.status, 302);
    const saved = yield* request("POST", `${prefix}/connections/${connection.id}/oauth/complete`, {
      callbackUrl: consent.headers.get("location"),
    });
    ids.push(saved.id);
  }
  yield* request("POST", `${appPath}/deploy`, { files });
  const updated = yield* request("GET", appPath);
  record(
    "health update keeps existing provider",
    updated.requirements.accounts.slack.provider,
    provider,
  );
  const check = (id) => request("POST", `${prefix}/accounts/${id}/health`);
  const status = (health) => health.apps.find((a) => a.app === app.id)?.check?.status;
  for (const [index, id] of ids.entries()) {
    const health = yield* check(id);
    record(`identity ${index + 1}`, health.info, {
      externalId: `U${index + 1}`,
      displayName: "Synthetic Person",
      username: "fixture-person",
      email: "person@example.test",
      avatarUrl: "https://example.test/avatar.png",
      profileUrl: "https://fixture.slack.com/",
    });
    record(`healthy ${index + 1}`, status(health), "healthy");
  }
  const cases = [
    ["invalid_auth", "credentials_rejected"],
    ["token_revoked", "credentials_rejected"],
    ["token_expired", "credentials_rejected"],
    ["not_authed", "credentials_rejected"],
    ["account_inactive", "credentials_rejected"],
    ["missing_scope", "forbidden"],
    ["no_permission", "forbidden"],
    ["ratelimited", "upstream_unavailable"],
    ["service_unavailable", "upstream_unavailable"],
    ["unknown_fixture_failure", "check_failed"],
  ];
  for (const [error, expected] of cases) {
    answer = { kind: "auth-error", error };
    record(error, status(yield* check(ids[0])), expected);
  }
  for (const [error, expected, http] of [
    ["invalid_auth", "credentials_rejected", 200],
    ["missing_scope", "forbidden", 403],
    ["ratelimited", "upstream_unavailable", 429],
  ]) {
    answer = { kind: "profile-error", error, status: http };
    record(`profile ${error}`, status(yield* check(ids[0])), expected);
  }
  answer = { kind: "optional" };
  const optional = yield* check(ids[0]);
  record("optional profile fields", optional.info, {
    externalId: "U1",
    displayName: "Synthetic Real",
    username: "fixture-person",
    profileUrl: "https://fixture.slack.com/",
  });
  record("optional metadata keeps health", status(optional), "healthy");
  answer = { kind: "success" };
  // A health-only update must keep the provider and both saved accounts.
  const changed = files.map((f) =>
    f.path === "index.ts" ? { ...f, content: `${f.content}\n// Health proof redeployment.\n` } : f,
  );
  yield* request("POST", `${appPath}/deploy`, { files: changed });
  const redeployed = yield* request("GET", appPath);
  record("provider identity retained", redeployed.requirements.accounts.slack.provider, provider);
  for (const [index, id] of ids.entries())
    record(
      `saved account ${index + 1} retained`,
      (yield* check(id)).info?.externalId,
      `U${index + 1}`,
    );
  record(
    "profile request identifies auth.test user",
    calls
      .filter((c) => c.path.endsWith("users.profile.get"))
      .every((c) => ["U1", "U2"].includes(c.user) && c.method === "GET"),
    true,
  );
  record(
    "profile request ran",
    calls.some((c) => c.path.endsWith("users.profile.get")),
    true,
  );
  return {
    results,
    sourceSha256: createHash("sha256").update(snapshotBytes).digest("hex"),
    fixtureMetadataOnly: true,
    beforeSha256: createHash("sha256").update(beforeBytes).digest("hex"),
  };
});
try {
  const report = await Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  const failed = results.filter((r) => !r.passed);
  console.log(JSON.stringify({ checks: results.length, failed, directory }));
  if (failed.length) process.exitCode = 1;
} catch (error) {
  await writeFile(join(directory, "partial-results.json"), JSON.stringify(results, null, 2), {
    mode: 0o600,
  });
  await writeFile(join(directory, "failure.txt"), String(error?.stack ?? error), { mode: 0o600 });
  console.error("Slack health proof failed; private diagnostics retained.");
  process.exitCode = 1;
}
