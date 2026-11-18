import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { State, StateStoreError, type StateService } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { encodeState } from "alchemy/State/StateEncoding";
import { Stack, evalStack } from "alchemy/Stack";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { containerPublication } from "./container-fixture.ts";
import { readForwardPacket } from "../forward-model.ts";
import { writeForwardJournal } from "../forward-journal.ts";
import { describeWorker, manifestDigest, type ReleaseManifest } from "../manifest.ts";
import { describeContainer, containerSnapshot } from "../container.ts";
import { runtimeReleaseState } from "../runtime-release-state.ts";
import { runtimeReleaseJournal, type RuntimeReleaseRecord } from "../runtime-release-journal.ts";
import { ordinaryReleaseWriter } from "../runtime-release-writer.ts";
import { withReleaseRuntime } from "../runtime.ts";
import type { SettlementOperationIo } from "../release-settlement-operation.ts";
import type { BaselineRead } from "../baseline-controller.ts";
import { legacyAdoptionTarget } from "../legacy-adoption-target.ts";
import { slotSelectionKey } from "../../../src/pool/runtime-slots/storage.ts";
import {
  activatedReceipt,
  previousController,
  settlementController,
} from "./settlement-controller.ts";

/**
 * `controllerActive` is the source after its controller phase: every Worker activated, nothing
 * adopted. `adopted` is that source after its adopt committed, as the production observe found it.
 * `recovered` is that adopted root after the controller's selected-runtime recovery restarted it
 * twice, leaving the selection at epoch 3.
 * `staleReadiness` is an abandoned source whose release froze the controller an earlier settlement
 * proved live, while the deferred readiness row still names the one before it.
 */
export async function releaseSettlementFixture(
  context: TestContext,
  options: {
    controllerActive?: boolean;
    adopted?: boolean;
    recovered?: boolean;
    staleReadiness?: boolean;
  } = {},
) {
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
    intents: unknown[] = [],
    runtimeReads: BaselineRead[] = [];
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
  // Scale-out code phases defer the readiness command, so after the source's controller phase it
  // still records the controller that ran before the source.
  const readinessCode =
    options.controllerActive || options.staleReadiness
      ? previousController(accountId, previous.hash!.image).code
      : code;
  await put(
    "PoolBackendBudgetRuntimeReady",
    "Command.Exec",
    {
      env: {
        GITHUB_SHA: readinessCode.candidate,
        DATABASE_BUDGET_WORKER_INPUT: readinessCode.workerInput,
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
  const active = new Map(
    manifest.workers.map((worker) => [
      worker.scriptName,
      options.controllerActive
        ? [{ versionId: `accepted-${worker.id}`, percentage: 100 }]
        : worker.baseline,
    ]),
  );
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
  const record: RuntimeReleaseRecord = {
    format: "pool-image-release-v1",
    candidate: sourceCandidate,
    complete: false,
    baseline,
    ...(options.controllerActive
      ? { baselineController: previousController(accountId, previous.hash!.image) }
      : options.staleReadiness
        ? { baselineController: { ...previousController(accountId, previous.hash!.image), code } }
        : {}),
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
      ...(options.controllerActive
        ? activatedReceipt(
            manifest.workers.map((worker) => worker.id),
            previous.version,
          )
        : {
            phase: "upload",
            accepted: [{ worker: "Api", versionId: "accepted-Api", startupTimeMs: 125 }],
            startupMeasurements: [
              { worker: "Api", versionId: "accepted-Api", startupTimeMs: 125 },
              { worker: "McpServer", versionId: "noisy-McpServer", startupTimeMs: 900 },
            ],
            activated: [],
            containers: [],
            pendingUpload: { worker: "McpServer" },
          }),
    },
    nativeBefore: encodeState(
      await Effect.runPromise(
        memory.get({ stack: scope.name, stage: scope.stage, fqn: "PoolContainer" }),
      ),
    ),
  });
  // A finished controller phase completes its head (deploy-stack.ts finish); an abandoned upload does not.
  await Effect.runPromise(
    writeForwardJournal(state, scope, key, packet, options.controllerActive === true),
  );
  const controller = settlementController({
    controllerId: instanceId,
    applicationId: previous.applicationId,
    imageInput: previous.hash!.image,
    code,
    key,
    calls,
  });
  if (options.adopted)
    await controller.adopt(
      legacyAdoptionTarget(baseline.applications.root, instanceId),
      `adopt-${sourceCandidate}`,
    );
  if (options.recovered) {
    await controller.restart("recovered-boot-1");
    await controller.restart("recovered-boot-2");
  }
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
    runtimeRead: async (call) => {
      runtimeReads.push(call);
    },
    connect: async () => ({
      dispose: async () => {},
      env: {
        POOL_OPERATIONS: {
          fetch: async (request) => {
            const path = new URL(request.url).pathname;
            if (request.method === "GET" && path === "/runtime-recovery") {
              calls.push("GET health");
              // Production answers the recovery read only before any selection exists.
              if (controller.storage.values.has(slotSelectionKey))
                return new Response(null, { status: 409 });
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
            return controller.handle(request);
          },
        },
      },
    }),
  };
  return {
    code,
    /** The source controller code a controller-active request names; tests may change it. */
    sourceController: (options.controllerActive ? code : undefined) as typeof code | undefined,
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
    runtimeReads,
    controller,
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
