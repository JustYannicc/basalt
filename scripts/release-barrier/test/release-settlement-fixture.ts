import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { ConfigProvider, Effect, Layer, Redacted, Schema } from "effect";
import { State, StateStoreError, type StateService } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { encodeState } from "alchemy/State/StateEncoding";
import { Stack, evalStack } from "alchemy/Stack";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { openEnvelope } from "../../../src/pool/token.ts";
import { ControllerCode } from "../../../src/pool/runtime-slots/contract.ts";
import { runtimeHandoffCommandPrefix } from "../../../src/pool/runtime-slots/handoff-command.ts";
import { containerPublication } from "./container-fixture.ts";
import { readForwardPacket } from "../forward-model.ts";
import { writeForwardJournal } from "../forward-journal.ts";
import { describeWorker, manifestDigest, type ReleaseManifest } from "../manifest.ts";
import { describeContainer, containerSnapshot } from "../container.ts";
import { runtimeReleaseState } from "../runtime-release-state.ts";
import { runtimeReleaseJournal } from "../runtime-release-journal.ts";
import { ordinaryReleaseWriter } from "../runtime-release-writer.ts";
import { withReleaseRuntime } from "../runtime.ts";
import type { SettlementOperationIo } from "../release-settlement-operation.ts";

export async function releaseSettlementFixture(context: TestContext) {
  context.mock.method(globalThis, "fetch", async () => {
    throw new Error("No network in the offline settlement proof");
  });
  const directory = await mkdtemp(join(tmpdir(), "release-settlement-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const scope = { name: "basalt", stage: "production" };
  const accountId = "1".repeat(32),
    key = "e".repeat(64),
    sourceCandidate = "a".repeat(40),
    candidate = "c".repeat(40);
  const code = { candidate: sourceCandidate, workerInput: "b".repeat(64) };
  const instanceId = "f".repeat(64);
  const setup = containerPublication();
  const previous = {
    ...setup.previous,
    accountId,
    configuration: {
      ...setup.previous.configuration,
      image: setup.previous.configuration.image.replace("/fixture/", `/${accountId}/`),
    },
  };
  const frozen = {
    ...setup.frozen,
    baseline: containerSnapshot(previous),
    rolloutRequest: { ...setup.frozen.rolloutRequest, accountId },
  };
  const memory = await Effect.runPromise(InMemoryService());
  let writes = 0,
    failWrite = false,
    bootId = "baseline-boot",
    placement = "off";
  const calls: string[] = [],
    intents: unknown[] = [];
  const state: StateService = {
    ...memory,
    setOutput: (request) =>
      memory.setOutput(request).pipe(
        Effect.flatMap(() => {
          if (request.stack.includes("release-settlement-")) {
            writes++;
            if (failWrite)
              return Effect.fail(
                new StateStoreError({ message: "Synthetic lost acknowledgement" }),
              );
          }
          return Effect.void;
        }),
      ),
  };
  const put = (
    fqn: string,
    resourceType: string,
    props: Record<string, unknown>,
    attr: Record<string, unknown>,
  ) =>
    Effect.runPromise(
      memory.set({
        stack: scope.name,
        stage: scope.stage,
        fqn,
        value: {
          resourceType,
          namespace: undefined,
          fqn,
          logicalId: fqn,
          instanceId: "2".repeat(32),
          providerVersion: 1,
          status: "updated",
          downstream: [],
          bindings: [],
          props,
          attr,
        },
      }),
    );
  for (const worker of ["Api", "McpServer", "PoolWorker"])
    await put(
      worker,
      "Cloudflare.Worker",
      worker === "PoolWorker"
        ? {
            env: {
              POOL_DATABASE_URL: Redacted.make(
                "postgresql://synthetic-secret@database.invalid/pool",
              ),
              POOL_MANAGEMENT_KEY: Redacted.make("synthetic-management"),
              POOL_APP_SIGNING_KEY: Redacted.make(key),
              POOL_DEPLOYMENT_KEY: Redacted.make(key),
              POOL_IMAGE_HASH: previous.hash!.image,
            },
          }
        : {},
      { accountId, workerName: worker },
    );
  await put("PoolContainer", "Cloudflare.Container", {}, previous);
  await put(
    "PoolBackendBudgetRuntimeReady",
    "Command.Exec",
    {
      env: {
        GITHUB_SHA: sourceCandidate,
        DATABASE_BUDGET_WORKER_INPUT: code.workerInput,
        DATABASE_BUDGET_IMAGE_HASH: previous.hash!.image,
        DATABASE_BUDGET_WORKER: "PoolWorker",
        CLOUDFLARE_ACCOUNT_ID: accountId,
      },
    },
    {},
  );
  const manifest: ReleaseManifest = {
    schemaVersion: 2,
    candidate: sourceCandidate,
    stack: scope.name,
    stage: scope.stage,
    containers: [frozen],
    workers: ["Api", "McpServer", "PoolWorker"].map((id) => ({
      id,
      accountId,
      scriptName: id,
      metadata: { mainModule: "main.js" },
      files: [
        {
          name: "main.js",
          type: "application/javascript+module",
          bytes: new TextEncoder().encode("export default {}"),
        },
      ],
      baseline: [{ versionId: `old-${id}`, percentage: 100 }],
      ...(id === "PoolWorker" ? { baselineImageHash: previous.hash!.image } : {}),
    })),
  };
  const active = new Map(manifest.workers.map((worker) => [worker.scriptName, worker.baseline]));
  const client = HttpClient.make((request, url) => {
    assert.equal(request.method, "GET");
    calls.push("GET deployment");
    const worker = url.pathname.split("/").at(-2)!;
    assert.ok(url.pathname.endsWith("/deployments"));
    return Effect.succeed(
      HttpResponse.fromWeb(
        request,
        Response.json({
          success: true,
          result: {
            deployments: [
              {
                id: `deployment-${worker}`,
                created_on: "2026-01-01T00:00:00Z",
                versions: active
                  .get(worker)!
                  .map((row) => ({ version_id: row.versionId, percentage: row.percentage })),
              },
            ],
          },
        }),
      ),
    );
  });
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(State, Effect.succeed(state)),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(
        Credentials,
        Effect.succeed({
          type: "apiToken",
          apiToken: Redacted.make("synthetic-api-token"),
          apiBaseUrl: "https://api.cloudflare.com/client/v4",
        }),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { EXECUTOR_ENCRYPTION_KEY: key, CLOUDFLARE_API_TOKEN: "synthetic-api-token" },
          }),
        ),
      ),
    );
  const stack = Stack(
    scope.name,
    { providers: Layer.empty, state: Layer.succeed(State, Effect.succeed(state)) },
    Effect.void,
  );
  const compiled = await Effect.runPromise(
    evalStack(stack, (value) => Effect.succeed(value), { stage: scope.stage }).pipe(
      withReleaseRuntime,
    ),
  );
  const writer = (sha = candidate) =>
    ordinaryReleaseWriter({
      GITHUB_ACTIONS: "true",
      GITHUB_REF: "refs/heads/main",
      GITHUB_JOB: "deploy",
      ALCHEMY_STAGE: "production",
      GITHUB_REPOSITORY: "JustYannicc/basalt",
      GITHUB_WORKFLOW_REF: "JustYannicc/basalt/.github/workflows/deploy.yml@refs/heads/main",
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      BASALT_RELEASE_CANDIDATE: sha,
    });
  const baseline = await Effect.runPromise(provide(runtimeReleaseState(scope)));
  const journal = await Effect.runPromise(
    provide(runtimeReleaseJournal(scope, writer(sourceCandidate), key)),
  );
  const record = {
    format: "pool-image-release-v1" as const,
    candidate: sourceCandidate,
    complete: false,
    baseline,
    desiredInput: "d".repeat(16),
    desiredConfiguration: baseline.configuration,
    bootstrap: {},
    configurations: {},
  };
  await journal.write(record);
  const description = {
    schemaVersion: 2 as const,
    candidate: sourceCandidate,
    stack: scope.name,
    stage: scope.stage,
    workers: manifest.workers.map(describeWorker),
    containers: [describeContainer(frozen)],
  };
  const packet = readForwardPacket({
    schemaVersion: 1,
    manifest: description,
    frozen: { ...description, containers: [frozen] },
    receipt: {
      schemaVersion: 2,
      candidate: sourceCandidate,
      manifest: manifestDigest(manifest),
      ceilingMs: 750,
      phase: "upload",
      accepted: [{ worker: "Api", versionId: "accepted-Api", startupTimeMs: 125 }],
      startupMeasurements: [
        { worker: "Api", versionId: "accepted-Api", startupTimeMs: 125 },
        { worker: "McpServer", versionId: "noisy-McpServer", startupTimeMs: 900 },
      ],
      activated: [],
      containers: [],
      pendingUpload: { worker: "McpServer" },
    },
    nativeBefore: encodeState(
      await Effect.runPromise(
        memory.get({ stack: scope.name, stage: scope.stage, fqn: "PoolContainer" }),
      ),
    ),
  });
  await Effect.runPromise(writeForwardJournal(state, scope, key, packet));
  const io: SettlementOperationIo = {
    directory,
    intent: async (value) => {
      intents.push(value);
    },
    container: () => Effect.succeed(previous),
    placement: (_account, worker, versionId) => {
      calls.push(`GET placement ${worker}`);
      return Effect.succeed({ id: versionId, placement: { mode: placement }, bindings: [] });
    },
    forward: {
      baseline: (worker) => {
        calls.push(`GET baseline ${worker.scriptName}`);
        return Effect.succeed([...active.get(worker.scriptName)!]);
      },
      observation: async () => ({
        version: previous.version,
        digest: previous.hash!.digest!,
        instances: [
          { id: instanceId, state: "running", digest: previous.hash!.digest!, startedAt: 1 },
        ],
      }),
    },
    connect: async () => ({
      dispose: async () => {},
      env: {
        POOL_OPERATIONS: {
          fetch: async (request) => {
            const path = new URL(request.url).pathname;
            if (request.method === "GET" && path === "/runtime-recovery") {
              calls.push("GET health");
              return Response.json({
                instanceId,
                imageHash: previous.hash!.image,
                release: sourceCandidate,
                running: true,
                ready: true,
                bootId,
              });
            }
            assert.equal(request.method, "POST");
            assert.equal(path, "/runtime-handoff");
            const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
              await request.json(),
            );
            const command = Schema.decodeUnknownSync(
              Schema.Struct({
                action: Schema.Literal("inspect"),
                controllerCode: ControllerCode,
                at: Schema.Number,
                expiresAt: Schema.Number,
              }),
              { onExcessProperty: "error" },
            )(await openEnvelope(key, runtimeHandoffCommandPrefix, body.envelope));
            assert.deepEqual(command.controllerCode, code);
            calls.push("POST inspect");
            return Response.json({ result: { controllerCode: code } });
          },
        },
      },
    }),
  };
  return {
    scope,
    accountId,
    key,
    candidate,
    sourceCandidate,
    compiled,
    provide,
    io,
    state,
    memory,
    writer,
    record,
    packet,
    active,
    calls,
    intents,
    provisioningWriter: { candidate, accountId, lease: "deploy-production:1:1" },
    writes: () => writes,
    failWrite: () => {
      failWrite = true;
    },
    changeBoot: () => {
      bootId = "changed-boot";
    },
    changePlacement: () => {
      placement = "smart";
    },
  };
}
