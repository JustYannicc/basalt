import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Output from "alchemy/Output";
import { isResolved } from "alchemy/Diff";
import { plannedReasons, imagePlanReasons } from "../plan-reasons.ts";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { ContainerPlatform } from "../../../node_modules/alchemy/src/Cloudflare/Containers/ContainerPlatform.ts";
import { LiveContainerProvider } from "../../../node_modules/alchemy/src/Cloudflare/Containers/ContainerProvider.ts";
import { WorkerUploadHook } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { Effect, Exit, Layer, Option, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import { Docker } from "alchemy/Docker/Docker";
import { attributes, preparedUpload } from "../fixture.ts";
import { describeContainer, sameContainerState, containerSnapshot } from "../container.ts";
import { decodeApplication } from "../container-cloudflare.ts";
import { deployStack } from "../deploy-stack.ts";
import { resumeForwardRelease } from "../forward-resume.ts";
import { verifyContainerHealth } from "../container-health.ts";
import { RuntimeRecovery } from "../../../src/pool/runtime-recovery.ts";
import { imageDigest } from "../container.ts";
import { forwardAdoption } from "../forward-model.ts";
import { encodeState } from "alchemy/State/StateEncoding";
import { describeWorker } from "../manifest.ts";
import { cloudflareArtifactsApi } from "../../ensure-artifacts.ts";
import { containerDriftApi, digest } from "../../upstream-tests/fixtures/container-drift-api.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const production = "a637b6ded731907c631794086598b3068220886e";
const without631 = "a7b1b47e1b83d2c9fff1b6e51e6844f202c6a634";
const imageCandidate = "2f2fad5e1050ffa2a51b5761315fcf8fab4a43dd";
const pinFiles = ["releases.json", "sources.json", "typesafe/go.mod", "typesafe/go.sum"];

/** Real root declarations and native Plan/Apply run end to end. Only control-plane effects, builds and stored state are synthetic. */
export const proveContainerStack = (source, recompile, scenario) =>
  Effect.gen(function* () {
    const context = mkdtempSync(join(tmpdir(), "container-root-"));
    for (const file of execFileSync("git", ["ls-files", "containers/pool"], {
      cwd: root,
      encoding: "utf8",
    })
      .trim()
      .split("\n")) {
      const target = join(context, file.slice("containers/pool/".length));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, file), target);
    }
    const pins = (revision) => {
      for (const name of pinFiles)
        writeFileSync(
          join(context, name),
          execFileSync(
            "git",
            [
              "show",
              `${revision === "candidate" ? imageCandidate : revision}:containers/pool/${name}`,
            ],
            { cwd: root },
          ),
        );
    };
    pins(production);
    const contextualize = (value) => ({
      ...value,
      resources: {
        ...value.resources,
        PoolContainer: {
          ...value.resources.PoolContainer,
          Props: { ...value.resources.PoolContainer.Props, context },
        },
      },
    });
    let stack = contextualize(source);
    const api = containerDriftApi({ rolloutOnly: true });
    api.app.account_id = "0".repeat(32);
    api.applicationExists = false;
    const events = [];
    const receipts = [];
    const publications = [];
    const normalizations = [];
    const liveVersions = new Map();
    let replaying = false;
    let replayOptions;
    let lastManifest;
    const recordedBaseline = scenario.startsWith("recorded-baseline");
    const sameDigest = [
      "same-digest",
      "same-digest-unhealthy",
      "dependency-only",
      "recorded-baseline-same-digest",
    ].includes(scenario);
    let releaseStarted = false;
    let attachmentPending = scenario === "dependency-only";
    let writes = 0,
      dockerCalls = 0;
    const docker = {
      image: {
        build: () => {
          dockerCalls++;
          return Effect.die("Docker forbidden in registry-cache proof");
        },
      },
    };
    const actual = yield* ContainerPlatform.Provider.pipe(
      Effect.provide(LiveContainerProvider()),
      Effect.provideService(HttpClient.HttpClient, api.http),
      Effect.provideService(Docker, docker),
    );
    let staged;
    let capturedPoolInput;
    let baselinePoolInput;
    const namespaces = Object.fromEntries(
      Object.values(stack.resources)
        .filter((resource) => resource.Type === "Cloudflare.Worker")
        .flatMap((resource) => Object.keys(resource.Props.exports ?? {}))
        .concat(["PoolContainer"])
        .map((name) => [name, `namespace-${name}`]),
    );
    const workerAttributes = (id) => ({
      ...attributes(id),
      accountId: "0".repeat(32),
      durableObjectNamespaces: namespaces,
    });
    const origin = {
      host: "fixture.invalid",
      port: 6432,
      database: "postgres",
      user: "fixture",
      password: Redacted.make("fixture"),
    };
    const otherAttributes = (input) => ({
      ...input.news,
      id: input.id,
      name: "fixture",
      accountId: "0".repeat(32),
      username: "fixture",
      host: "fixture.invalid",
      hostname: "fixture.invalid",
      port: 6432,
      origin,
      pooledOrigin: origin,
      connectionUrl: Redacted.make("postgresql://fixture:fixture@fixture.invalid/postgres"),
      text: "fixture",
      value: Redacted.make("fixture"),
      mtlsCertificateId: "fixture",
      hash: { input: "fixture" },
    });
    const providers = [...new Set(Object.values(stack.resources).map((resource) => resource.Type))]
      .filter(
        (type) => !["Cloudflare.Container", "Cloudflare.Worker", "Command.Exec"].includes(type),
      )
      .map((type) =>
        Provider.succeed(Resource(type), {
          reconcile: (input) => Effect.succeed(otherAttributes(input)),
          delete: () => Effect.die("Unexpected deletion"),
        }),
      );
    providers.push(Provider.succeed(Resource("Cloudflare.Container"), actual));
    providers.push(
      Provider.succeed(Resource("Cloudflare.Worker"), {
        stables: ["workerId", "workerName"],
        precreate: ({ id }) => Effect.succeed(workerAttributes(id)),
        diff: ({ output }) =>
          Effect.sync(() => {
            assert.deepEqual(output.durableObjectNamespaces, namespaces);
            return {
              action: "update",
              stables: [
                "workerId",
                "workerName",
                ...(attachmentPending ? [] : ["durableObjectNamespaces"]),
              ],
            };
          }),
        reconcile: (input) =>
          Effect.gen(function* () {
            const result = workerAttributes(input.id);
            const hook = yield* Effect.serviceOption(WorkerUploadHook);
            if (Option.isNone(hook)) {
              if (input.id === "PoolWorker") baselinePoolInput = input.news.env.POOL_IMAGE_HASH;
              return result;
            }
            const upload = preparedUpload(input.id);
            if (scenario === "partial-worker-forward") upload.request.accountId = "0".repeat(32);
            if (input.id === "PoolWorker") {
              capturedPoolInput = input.news.env.POOL_IMAGE_HASH;
              upload.previousSettings.bindings.push({
                name: "POOL_IMAGE_HASH",
                type: "plain_text",
                text: ["baseline-worker-input-drift", "latest-upload-baseline"].includes(scenario)
                  ? "foreign-input-hash"
                  : baselinePoolInput,
              });
              upload.request.metadata.bindings.push({
                name: "POOL_IMAGE_HASH",
                type: "plain_text",
                text: capturedPoolInput,
              });
            }
            return yield* hook.value.capture({
              ...upload,
              proposed: result,
              activate: (versionId) =>
                Effect.sync(() => {
                  liveVersions.set(input.id, [{ versionId, percentage: 100 }]);
                  if (
                    scenario === "partial-worker-forward" &&
                    input.id === "PoolWorker" &&
                    !replaying
                  )
                    throw new Error("Interrupted after PoolWorker activation");
                  events.push(`activate:${input.id}`);
                  return scenario === "activated-worker-attributes"
                    ? {
                        ...result,
                        versionId,
                        deploymentId: `deployment-${input.id}`,
                      }
                    : result;
                }),
            });
          }),
        delete: () => Effect.die("Unexpected deletion"),
      }),
    );
    providers.push(
      Command.ExecProvider().pipe(
        Layer.provide(
          Layer.succeed(Command.CommandExecutor, {
            spawn: () => Effect.die("No child processes in the release graph"),
            run: (input) =>
              Effect.sync(() => {
                events.push(`command:${input.command}`);
                return { exitCode: 0, stdout: "", stderr: "" };
              }),
          }),
        ),
      ),
    );
    const memory = yield* InMemoryService();
    const state = {
      ...memory,
      set: (input) =>
        Effect.gen(function* () {
          writes++;
          const result = yield* memory.set(input);
          if (
            releaseStarted &&
            ["native-state-drift", "database-dependency-drift"].includes(scenario) &&
            input.fqn === "PoolDatabase" &&
            input.value.status === "updated"
          ) {
            const key = {
              stack: input.stack,
              stage: input.stage,
              fqn: scenario === "database-dependency-drift" ? "PoolDatabaseRole" : "Api",
            };
            const current = yield* memory.get(key);
            assert.ok(current && "attr" in current);
            yield* memory.set({
              ...key,
              value: { ...current, attr: { ...current.attr, workerId: "foreign-native-record" } },
            });
            events.push("native:drift");
          }
          return result;
        }),
      setOutput: (input) =>
        Effect.sync(() => {
          writes++;
        }).pipe(Effect.andThen(memory.setOutput(input))),
    };
    const run = (effect) =>
      effect.pipe(
        Effect.provideService(State, Effect.succeed(state)),
        Effect.provideService(HttpClient.HttpClient, api.http),
        Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId: "0".repeat(32) })),
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("synthetic-never-sent"),
            apiBaseUrl: "https://fixture.invalid",
          }),
        ),
        Effect.provideService(Docker, docker),
        Effect.provide(Layer.mergeAll(...providers)),
        Effect.provideContext(stack.services),
      );
    // Production declarations contain explicit reads of the already-deployed role records.
    const databaseSeed = {
      ...stack,
      resources: Object.fromEntries(
        Object.entries(stack.resources).filter(([, resource]) =>
          resource.Type.startsWith("Planetscale."),
        ),
      ),
      bindings: {},
      actions: {},
      output: {},
    };
    yield* run(Apply.apply(yield* run(Plan.make(databaseSeed))));
    yield* run(Apply.apply(yield* run(Plan.make(stack))));
    if (recordedBaseline) {
      const key = { stack: stack.name, stage: stack.stage, fqn: "PoolContainer" };
      const saved = yield* memory.get(key);
      assert.ok(saved && "attr" in saved);
      const {
        vcpu: _vcpu,
        memory: _memory,
        memoryMib: _mib,
        disk: _disk,
        command: _command,
        entrypoint: _entrypoint,
        network: _network,
        runtime: _runtime,
        ...configuration
      } = saved.attr.configuration;
      yield* memory.set({
        ...key,
        value: {
          ...saved,
          attr: {
            ...saved.attr,
            version: 25,
            configuration: { ...configuration, instanceType: "basic" },
          },
        },
      });
      api.app = {
        ...api.app,
        version: 26,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:01Z",
        network: { bandwidth_limit_mbps: 250 },
        configuration: {
          ...api.app.configuration,
          command: [],
          entrypoint: [],
          network: { assign_ipv4: "none", assign_ipv6: "none", mode: "private" },
          runtime: "firecracker",
        },
      };
    }
    return yield* recompile((next) =>
      Effect.gen(function* () {
        stack = contextualize(next);
        pins(without631);
        const intermediate = yield* run(Plan.make(stack));
        assert.equal(intermediate.resources.PoolContainer.action, "update");
        if (["new-runtime-ready", "new-ready-late-rejection"].includes(scenario))
          yield* memory.delete({
            stack: stack.name,
            stage: stack.stage,
            fqn: "PoolBackendBudgetRuntimeReady",
          });
        if (["creating-runtime-ready", "creating-ready-late-rejection"].includes(scenario)) {
          const key = {
            stack: stack.name,
            stage: stack.stage,
            fqn: "PoolBackendBudgetRuntimeReady",
          };
          const saved = yield* memory.get(key);
          assert.ok(saved && "props" in saved);
          const { attr: _attr, ...creating } = saved;
          yield* memory.set({ ...key, value: { ...creating, status: "creating" } });
        }
        pins(scenario === "dependency-only" ? production : "candidate");
        const plan = yield* run(Plan.make(stack));
        assert.equal(plan.resources.PoolContainer.action, "update");
        if (["creating-runtime-ready", "creating-ready-late-rejection"].includes(scenario)) {
          const ready = plan.resources.PoolBackendBudgetRuntimeReady;
          assert.equal(ready.action, "create");
          assert.equal(ready.state.status, "creating");
          assert.equal(ready.state.attr, undefined);
        }
        const planReasons = [
          ...plannedReasons(plan, plan.resources.PoolContainer),
          ...((yield* run(imagePlanReasons(plan))).get("PoolContainer") ?? []),
        ];
        api.writes = 0;
        api.rollouts = 0;
        writes = 0;
        events.length = 0;
        if (!sameDigest) api.publishedDigest = digest("3");
        releaseStarted = true;
        let exit = yield* Effect.exit(
          run(
            deployStack(
              stack,
              (replayOptions = {
                candidate: "a".repeat(40),
                ...(scenario === "partial-worker-forward"
                  ? { forwardEncryptionKey: "b".repeat(64) }
                  : {}),
                record: async (receipt) => {
                  receipts.push(receipt);
                },
                manifest: async (value) => {
                  lastManifest = value;
                },
                admission: async (verifications) => {
                  assert.equal(verifications.length, 1);
                  const readiness = verifications[0];
                  assert.equal(readiness.fqn, "PoolBackendBudgetRuntimeReady");
                  assert.equal(
                    readiness.lifecycle,
                    plan.resources.PoolBackendBudgetRuntimeReady.state?.status ?? "absent",
                  );
                  assert.ok(readiness.envChanges.includes("DATABASE_BUDGET_IMAGE_HASH"));
                  events.push("verification:admitted");
                },
                publication: async (container, normalization) => {
                  publications.push(describeContainer(container));
                  if (normalization) normalizations.push(normalization);
                  events.push("image:retained");
                },
                io: {
                  placements: (_worker, baseline) =>
                    Effect.succeed(
                      baseline.map(({ versionId }) => ({
                        id: versionId,
                        placement: undefined,
                        bindings: [
                          {
                            name: "POOL_IMAGE_HASH",
                            type: "plain_text",
                            text:
                              scenario === "baseline-worker-input-drift"
                                ? "foreign-input-hash"
                                : baselinePoolInput,
                          },
                        ],
                      })),
                    ),
                  advanceContainer: (_target, rollout) =>
                    Effect.sync(() => {
                      assert.equal(staged.rolloutRequest.kind, "full_manual");
                      assert.equal(rollout.id, "fixture-rollout-1");
                      assert.ok(api.manualRollout);
                      assert.equal(api.app.version, rollout.currentVersion);
                      api.app = { ...api.manualRollout, active_rollout_id: null };
                      events.push("container:advance");
                    }),
                  serving: (container, _worker, candidate) =>
                    Effect.sync(() => {
                      assert.equal(api.app.configuration.image, container.configuration.image);
                      if (
                        [
                          "unhealthy-serving",
                          "same-digest-unhealthy",
                          "recorded-baseline-unhealthy",
                        ].includes(scenario)
                      )
                        throw new Error("serving checks failed");
                      events.push("container:serving");
                      return {
                        candidate,
                        applicationVersion: api.app.version,
                        digest: container.imageDigest,
                        inputHash: container.inputHash,
                        bootId: "fixture-boot",
                        instanceId: "a".repeat(64),
                        workerInput: "fixture-input",
                        checkedAt: 123,
                        unsignedHealth: 200,
                        unsignedModels: 401,
                      };
                    }),
                  container: (publication) =>
                    Effect.sync(() => {
                      assert.equal(api.writes, 0);
                      assert.equal(api.rollouts, 0);
                      events.push("image:admitted");
                      staged = publication;
                      if (recordedBaseline)
                        assert.equal(
                          sameContainerState(
                            decodeApplication(api.app),
                            containerSnapshot(publication.previous),
                          ),
                          true,
                        );
                      return {
                        digest: publication.proposed.hash.digest,
                        configDigest: digest("4"),
                        platform: "linux/amd64",
                        capabilityLabel: "1",
                      };
                    }),
                  observeContainer: () =>
                    recordedBaseline
                      ? Effect.sync(() => decodeApplication(api.app))
                      : staged
                          .read()
                          .pipe(
                            Effect.map((value) =>
                              scenario === "container-drift" ? { ...value, version: 99 } : value,
                            ),
                          ),
                  namespace: (account, token) =>
                    cloudflareArtifactsApi(account, token, async (_input, init) => {
                      assert.equal(init.method, "GET");
                      return Response.json({
                        success: true,
                        result: ["basalt-production-apps", "basalt-production-vaults"].map((namespace) => ({
                          namespace,
                          jurisdiction: "eu",
                        })),
                      });
                    }),
                  baseline: (worker) =>
                    Effect.succeed(
                      liveVersions.get(worker.scriptName) ?? [
                        { versionId: "previous", percentage: 100 },
                      ],
                    ),
                  upload: (worker) =>
                    Effect.sync(() => {
                      assert.equal(api.writes, 0);
                      assert.equal(api.rollouts, 0);
                      events.push(`admit:${worker.id}`);
                      if (
                        worker.id === "Router" &&
                        [
                          "late-worker-rejection",
                          "new-ready-late-rejection",
                          "creating-ready-late-rejection",
                          "recorded-baseline-rejected",
                        ].includes(scenario)
                      )
                        throw new Error("Rejected late upload");
                      if (worker.id === "Router" && scenario === "source-drift")
                        writeFileSync(
                          join(context, "Dockerfile"),
                          readFileSync(join(context, "Dockerfile"), "utf8") +
                            "\nLABEL changed_after_freeze=true\n",
                        );
                      return {
                        versionId: `accepted-${worker.id}`,
                        ...(worker.id === "Router" && scenario === "missing-startup"
                          ? {}
                          : {
                              startupTimeMs:
                                scenario === "over-ceiling" && worker.id === "Router" ? 751 : 100,
                            }),
                      };
                    }),
                },
              }),
            ),
          ),
        );
        if (scenario === "partial-worker-forward") {
          assert.ok(Exit.isFailure(exit));
          assert.equal(receipts.at(-1).pending.worker, "PoolWorker");
          assert.equal(api.writes, 0);
          const key = { stack: stack.name, stage: stack.stage, fqn: "PoolContainer" };
          const before = yield* memory.get(key);
          const candidateWorkerHash = capturedPoolInput;
          const instanceId = "a".repeat(64);
          const runtime = new RuntimeRecovery(
            {
              instanceId,
              imageHash: candidateWorkerHash,
              running: () => true,
              status: async () => ({ boot_id: "fixture-boot" }),
              restart: async () => {
                throw new Error("Passive proof must not restart");
              },
            },
            { get: async () => undefined, put: async () => {} },
          );
          const forward = yield* run(
            resumeForwardRelease(stack, {
              directory: context,
              io: {
                baseline: (worker) =>
                  Effect.succeed(
                    liveVersions.get(worker.scriptName) ?? [
                      { versionId: "previous", percentage: 100 },
                    ],
                  ),
                container: () => staged.read(),
                observation: async () => ({
                  version: api.app.version,
                  digest: imageDigest(api.app.configuration.image),
                  instances: [
                    {
                      id: instanceId,
                      state: "running",
                      digest: imageDigest(api.app.configuration.image),
                      startedAt: "2026-11-08T00:00:00Z",
                    },
                  ],
                }),
                health: (target, hash, signal, diagnostic) =>
                  verifyContainerHealth(
                    {
                      ...target,
                      connect: async () => ({
                        dispose: async () => {},
                        env: {
                          POOL_OPERATIONS: {
                            fetch: async (request) => {
                              assert.equal(request.method, "GET");
                              return Response.json(await runtime.inspect());
                            },
                          },
                        },
                      }),
                    },
                    hash,
                    signal,
                    diagnostic,
                  ),
              },
            }),
          );
          assert.ok(forward.continuation);
          assert.equal(forward.continuation.workerInputHash, candidateWorkerHash);
          const after = yield* memory.get(key);
          assert.equal(
            after.attr.hash.image,
            before.attr.hash.image,
            "baseline attrs remain real before rollout",
          );
          const pendingJournal = yield* memory.getOutput({
            stack: `${stack.name}-release-barrier`,
            stage: stack.stage,
          });
          assert.equal(
            pendingJournal.complete,
            false,
            "continuation survives failure before the next Plan",
          );
          baselinePoolInput = candidateWorkerHash;
          replaying = true;
          events.length = 0;
          publications.length = 0;
          exit = yield* Effect.exit(
            recompile((next) => {
              stack = contextualize(next);
              return run(
                deployStack(stack, { ...replayOptions, forwardInput: forward.continuation }),
              );
            }),
          );
        }
        assert.equal(
          publications.length,
          1,
          "publication survives later preparation or admission failure",
        );
        assert.equal(publications[0].inputHash, staged.proposed.hash.image);
        if (recordedBaseline) {
          assert.equal(publications[0].baselineVersion, 26);
          assert.equal(publications[0].baselineDigest, staged.previous.hash.digest);
          assert.equal(publications[0].imageDigest === publications[0].baselineDigest, sameDigest);
          assert.equal(normalizations.length, 1);
          assert.equal(normalizations[0].recordedVersion, 25);
          assert.equal(normalizations[0].observedVersion, 26);
          assert.equal(normalizations[0].disposition, "observed-baseline");
        }
        const firstAdmission = events.findIndex((event) => event.startsWith("admit:"));
        assert.ok(events.indexOf("image:retained") >= 0);
        if (firstAdmission >= 0) assert.ok(events.indexOf("image:retained") < firstAdmission);
        if (["native-state-drift", "database-dependency-drift"].includes(scenario)) {
          assert.ok(events.includes("native:drift"));
          assert.equal(receipts.at(-1).failure.reason, "alchemy-state-drift");
        }
        const succeeded = Exit.isSuccess(exit);
        const expectedSuccess = [
          "success",
          "activated-worker-attributes",
          "latest-upload-baseline",
          "updating-forward",
          "partial-worker-forward",
          "same-digest",
          "dependency-only",
          "new-runtime-ready",
          "creating-runtime-ready",
          "recorded-baseline",
          "recorded-baseline-same-digest",
        ].includes(scenario);
        const workerInputMatches = staged?.proposed.hash.image === capturedPoolInput;
        assert.equal(
          workerInputMatches,
          true,
          "Actual root POOL_IMAGE_HASH must consume the staged native attributes",
        );
        if (!succeeded && expectedSuccess) return yield* Effect.failCause(exit.cause);
        assert.equal(succeeded, expectedSuccess);
        let unchangedAction;
        if (succeeded) {
          if (scenario === "latest-upload-baseline")
            assert.equal(
              lastManifest.workers.find((worker) => worker.id === "PoolWorker").baselineImageHash,
              baselinePoolInput,
            );
          assert.equal(api.writes, sameDigest ? 0 : 1);
          assert.equal(api.rollouts, sameDigest ? 0 : 1);
          assert.equal(api.app.configuration.image, staged.proposed.configuration.image);
          const allWorkers = Object.values(stack.resources).filter(
            (resource) => resource.Type === "Cloudflare.Worker",
          );
          const firstActivation = events.findIndex((event) => event.startsWith("activate:"));
          assert.ok(
            allWorkers.every(
              (worker) =>
                events.indexOf(`admit:${worker.FQN}`) > -1 &&
                events.indexOf(`admit:${worker.FQN}`) < firstActivation,
            ),
          );
          assert.ok(events.indexOf("image:admitted") < firstActivation);
          assert.ok(
            events.includes("container:serving"),
            "every staged container verifies serving before native commit",
          );
          if (["new-runtime-ready", "creating-runtime-ready"].includes(scenario)) {
            const ready = events.indexOf("command:node verify-database-budget.ts --ready");
            assert.ok(ready > events.indexOf("container:serving"));
            assert.equal(
              events.filter((event) => event === "command:node verify-database-budget.ts --ready")
                .length,
              1,
            );
          }
          assert.ok(events.includes("verification:admitted"));
          assert.equal(receipts.at(-1).phase, "complete");
          if (scenario === "activated-worker-attributes") {
            const apiState = yield* memory.get({
              stack: stack.name,
              stage: stack.stage,
              fqn: "Api",
            });
            assert.equal(apiState.attr.versionId, "accepted-Api");
            assert.equal(apiState.attr.deploymentId, "deployment-Api");
          }
          if (recordedBaseline) {
            const saved = yield* memory.get({
              stack: stack.name,
              stage: stack.stage,
              fqn: "PoolContainer",
            });
            assert.equal(saved.attr.version, sameDigest ? 26 : 27);
            assert.equal(saved.attr.hash.digest, staged.proposed.hash.digest);
            assert.equal(saved.attr.hash.image, capturedPoolInput);
            if (sameDigest) {
              assert.ok(!events.includes("container:advance"));
              assert.equal(receipts.at(-1).containers[0].unchanged, true);
            } else {
              assert.ok(events.indexOf("container:advance") > firstActivation);
              assert.ok(events.indexOf("container:serving") > events.indexOf("container:advance"));
            }
          }
          attachmentPending = false;
          const next = yield* run(Plan.make(stack));
          unchangedAction = next.resources.PoolContainer.action;
          assert.equal(unchangedAction, "noop");
          if (scenario === "updating-forward") {
            const key = { stack: stack.name, stage: stack.stage, fqn: "PoolContainer" };
            const saved = yield* memory.get(key);
            const baseline = { ...saved, attr: staged.previous };
            const wrapped = { ...baseline, status: "updating", old: baseline };
            const manifest = {
              ...lastManifest,
              workers: lastManifest.workers.map(describeWorker),
              containers: lastManifest.containers.map(describeContainer),
            };
            const packet = {
              schemaVersion: 1,
              manifest,
              frozen: { ...manifest, containers: lastManifest.containers },
              receipt: receipts.at(-1),
              nativeBefore: encodeState(wrapped),
            };
            const adopted = forwardAdoption(packet, wrapped, {
              ...staged.proposed,
              version: api.app.version,
            });
            assert.equal(adopted.after.attr.hash.image, staged.proposed.hash.image);
            assert.equal(adopted.after.old.attr.hash.image, staged.proposed.hash.image);
            yield* memory.set({ ...key, value: adopted.after });
            const writesBefore = api.writes;
            const rolloutsBefore = api.rollouts;
            api.writes = 0;
            api.rollouts = 0;
            baselinePoolInput = capturedPoolInput;
            yield* recompile((next) => {
              stack = contextualize(next);
              return run(deployStack(stack, { ...replayOptions, admission: undefined }));
            });
            assert.equal(api.writes, 0, "replay must not redeploy the verified container");
            assert.equal(api.rollouts, 0);
            api.writes = writesBefore;
            api.rollouts = rolloutsBefore;
            const finalized = yield* memory.get(key);
            assert.equal(finalized.attr.hash.image, staged.proposed.hash.image);
            assert.equal(finalized.attr.version, api.app.version);
            const finalPlan = yield* run(Plan.make(stack));
            assert.equal(finalPlan.resources.PoolContainer.action, "noop");
          }
        } else if (
          ["unhealthy-serving", "same-digest-unhealthy", "recorded-baseline-unhealthy"].includes(
            scenario,
          )
        ) {
          const changedImage = scenario !== "same-digest-unhealthy";
          assert.equal(api.writes, changedImage ? 1 : 0);
          assert.equal(api.rollouts, changedImage ? 1 : 0);
          assert.equal(receipts.at(-1).pendingContainer.phase, "verification");
          const saved = yield* memory.get({
            stack: stack.name,
            stage: stack.stage,
            fqn: "PoolContainer",
          });
          assert.equal(saved.attr.configuration.image, staged.previous.configuration.image);
          assert.equal(saved.attr.version, recordedBaseline ? 25 : staged.previous.version);
          assert.equal(saved.attr.hash.image, staged.previous.hash.image);
        } else {
          assert.equal(api.writes, 0);
          assert.equal(api.rollouts, 0);
          assert.ok(!events.some((event) => event.startsWith("activate:")));
          if (
            [
              "late-worker-rejection",
              "new-ready-late-rejection",
              "creating-ready-late-rejection",
              "recorded-baseline-rejected",
              "missing-startup",
              "over-ceiling",
            ].includes(scenario)
          ) {
            assert.ok(!events.some((event) => event.startsWith("command:")));
            assert.equal(writes, 0);
            if (recordedBaseline) {
              const saved = yield* memory.get({
                stack: stack.name,
                stage: stack.stage,
                fqn: "PoolContainer",
              });
              assert.equal(saved.attr.version, 25);
              assert.equal(saved.attr.hash.digest, staged.previous.hash.digest);
            }
          }
        }
        assert.equal(dockerCalls, 0);
        return {
          scenario,
          succeeded,
          without631Action: intermediate.resources.PoolContainer.action,
          containerAction: plan.resources.PoolContainer.action,
          workerInputMatches,
          applicationWrites: api.writes,
          rollouts: api.rollouts,
          dockerCalls,
          events,
          ...(unchangedAction ? { unchangedAction } : {}),
          liveStateWrites: writes,
          planReasons,
          containerDependencies: Object.keys(
            Output.upstreamAny(stack.bindings.PoolContainer ?? []),
          ),
          containerBindingUnresolved: !isResolved(plan.resources.PoolContainer.bindings),
          readinessDependencies: Object.keys(
            Output.upstreamAny(stack.resources.PoolBackendBudgetRuntimeReady.Props),
          ),
        };
      }),
    );
  });
