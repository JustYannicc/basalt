import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { Context, Effect, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { startEnvironment } from "../../.upstream/e2e/sdk/environment.ts";
import { prepareScenario } from "../../.upstream/e2e/sdk/scenario.ts";
import { appsManifest } from "../../.upstream/e2e/support/apps-release.ts";
import { freePort } from "../../.upstream/e2e/support/ports.ts";
import { startManagedServer } from "../../.upstream/e2e/support/managed-server.ts";
import { Target } from "../../.upstream/e2e/support/platform.ts";
import { SessionClients } from "../../.upstream/e2e/support/api.ts";
import { lockedNpmRegistry } from "../../.upstream/e2e/support/npm-registry.ts";
import { firstPartyOAuthClientDefinitions } from "../../.upstream/apps/hosted/server/src/implementation/first-party-oauth.ts";
import { brand } from "../../brand.ts";
import { loadGoogleAdminCatalog } from "./google-admin-catalog.mjs";
import { proveGoogleAdminOAuth } from "./google-admin-scenario.mjs";
import { provisionSelfHostActors } from "./test-accounts.mjs";
import { pinProofSource } from "./provider-evidence.mjs";

const scriptRoot = fileURLToPath(new URL("../..", import.meta.url));
const root = resolve(process.argv[2] ?? scriptRoot);
assert.equal(root, resolve(scriptRoot), "The root must be this runner's checkout");
const upstream = join(root, ".upstream");
const snapshotsDirectory = resolve(
  process.argv[3] ?? join(root, ".generated/google-admin-snapshots"),
);
const evidenceRoot = resolve(
  process.argv[4] ?? join(root, ".generated/google-admin-proof"),
);
const candidateCommit = process.argv[5];
const baseCommit = process.argv[6];
const sourcePin = pinProofSource(root, candidateCommit, baseCommit);
const runId =
  "google-admin-" +
  new Date().toISOString().replaceAll(":", "-") +
  "-" +
  randomBytes(3).toString("hex");
const evidenceDirectory = join(evidenceRoot, runId);
const evidenceFile = join(evidenceDirectory, "google-admin-proof.json");
const state = {
  stage: "initialization",
  checks: [],
  snapshots: {},
  deployments: [],
  failures: [],
};
const privateValues = ["synthetic-google-secret"];
const record = (name) => state.checks.push(name);
const setStage = (name) => {
  state.stage = name;
};

const checked = (response, status, operation) => {
  if (response.status !== status) {
    const tag =
      response.body !== null &&
      typeof response.body === "object" &&
      typeof response.body._tag === "string"
        ? response.body._tag
        : undefined;
    const diagnostic = {
      status: response.status,
      ...(tag === undefined ? {} : { _tag: tag }),
    };
    state.failures.push({ operation, ...diagnostic });
    assert.equal(
      response.status,
      status,
      operation + " returned " + JSON.stringify(diagnostic),
    );
  }
  return response.body;
};

setStage("read-official-google-snapshots");
const catalog = await loadGoogleAdminCatalog({
  upstream,
  snapshotsDirectory,
  firstPartyOAuthClientDefinitions,
});
const {
  admin,
  adminScopes,
  adminFiles,
  googleClient,
  metadata: googleMetadata,
  normal,
  snapshots,
  appsVersion,
} = catalog;
const adminDeclaration = admin;
const normalDeclaration = normal;
record(
  "Official Google and Google Admin source match Google OIDC endpoints, client auth, hosts and requested scopes",
);

process.chdir(upstream);
state.snapshots = snapshots;

const clientId = "synthetic-google-client.apps.googleusercontent.com";
const callbackUrl = "https://app.signalbox.run/api/oauth/callback";
const productName = brand.name;
const program = Effect.gen(function* () {
  setStage("start-pinned-self-host-runtime");
  const base = yield* startEnvironment({ target: "self-host", headless: true });
  const registry = yield* lockedNpmRegistry;
  const prepared = yield* prepareScenario(
    base.target,
    "Google Admin shared OAuth selection proof",
  );
  const port = yield* freePort;
  const authSecret = randomBytes(32).toString("hex");
  const preparedTarget = Target.of({
    ...prepared,
    metadata: { ...prepared.metadata, origin: `http://127.0.0.1:${port}` },
  });
  const cliActors = yield* Effect.promise(() =>
    provisionSelfHostActors({
      executable: process.execPath,
      upstream,
      target: preparedTarget,
      authSecret,
      directory: evidenceDirectory,
      organization: "google-admin-native",
      namePrefix: "google-admin",
    }),
  );
  const server = yield* startManagedServer(preparedTarget, "product", {
    BETTER_AUTH_SECRET: authSecret,
    EXECUTOR_OAUTH_CALLBACK_URL: callbackUrl,
    EXECUTOR_PRODUCT_NAME: productName,
    EXECUTOR_NPM_REGISTRY: registry.url,
    EXECUTOR_OAUTH_GOOGLE_CLIENT_ID: clientId,
    EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET: privateValues[0],
  });
  const runtimeTarget = Target.of({
    ...preparedTarget,
    controlOrigin: server.controlOrigin,
    metadata: { ...preparedTarget.metadata, origin: server.origin },
  });
  const services = yield* Layer.build(
    SessionClients.layer.pipe(
      Layer.provideMerge(Layer.succeed(Target, runtimeTarget)),
    ),
  );
  const sessions = Context.get(services, SessionClients);
  const owner = yield* sessions.session(Redacted.make(cliActors.owner.cookies));
  const adminActor = yield* sessions.session(Redacted.make(cliActors.admin.cookies));
  const member = yield* sessions.session(Redacted.make(cliActors.member.cookies));
  const actors = {
    organization: cliActors.organization,
    owner,
    admin: adminActor,
    member,
  };
  const request = (actor, method, path, data) =>
    sessions.request(actor, method, path, data);
  const orgPath = "/api/organizations/" + actors.organization.id;
  const proof = yield* proveGoogleAdminOAuth({
    actors,
    admin: adminDeclaration,
    adminFiles,
    adminScopes,
    appsManifest,
    callbackUrl,
    checked,
    clientId,
    googleClient,
    googleMetadata,
    normal: normalDeclaration,
    orgPath,
    productName,
    record,
    request,
    setStage,
    state,
  });
  return {
    outcome: "passed",
    sourcePin,
    snapshots: state.snapshots,
    appsVersion,
    deployments: state.deployments,
    checks: state.checks,
    ...proof,
  };
});

await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
await chmod(evidenceDirectory, 0o700);
try {
  const result = await Effect.runPromise(
    program.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
  );
  await writeFile(
    evidenceFile,
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ outcome: result.outcome, checks: result.checks.length }),
  );
} catch {
  await writeFile(
    evidenceFile,
    JSON.stringify(
      {
        outcome: "failed",
        sourcePin,
        stage: state.stage,
        checksCompleted: state.checks,
        snapshots: state.snapshots,
        deployments: state.deployments,
        failures: state.failures,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.error("Google Admin OAuth proof failed; stage and check results were retained.");
  process.exitCode = 1;
}
