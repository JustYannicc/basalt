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
import { describeContainer } from "../container.ts";
import { deployStack } from "../deploy-stack.ts";
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
            if (input.id === "PoolWorker") {
              capturedPoolInput = input.news.env.POOL_IMAGE_HASH;
              upload.previousSettings.bindings.push({
                name: "POOL_IMAGE_HASH",
                type: "plain_text",
                text:
                  scenario === "baseline-worker-input-drift"
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
              activate: () =>
                Effect.sync(() => {
                  events.push(`activate:${input.id}`);
                  return result;
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
        pins(scenario === "dependency-only" ? production : "candidate");
        const plan = yield* run(Plan.make(stack));
        assert.equal(plan.resources.PoolContainer.action, "update");
        const planReasons = [
          ...plannedReasons(plan, plan.resources.PoolContainer),
          ...((yield* run(imagePlanReasons(plan))).get("PoolContainer") ?? []),
        ];
        api.writes = 0;
        api.rollouts = 0;
        writes = 0;
        events.length = 0;
        if (!["same-digest", "same-digest-unhealthy", "dependency-only"].includes(scenario))
          api.publishedDigest = digest("3");
        releaseStarted = true;
        const exit = yield* Effect.exit(
          run(
            deployStack(stack, {
              candidate: "a".repeat(40),
              record: async (receipt) => {
                receipts.push(receipt);
              },
              manifest: async () => {},
              publication: async (container) => {
                publications.push(describeContainer(container));
                events.push("image:retained");
              },
              io: {
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
                    if (["unhealthy-serving", "same-digest-unhealthy"].includes(scenario))
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
                    return {
                      digest: publication.proposed.hash.digest,
                      configDigest: digest("4"),
                      platform: "linux/amd64",
                      capabilityLabel: "1",
                    };
                  }),
                observeContainer: () =>
                  staged
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
                      result: [{ namespace: "basalt-production-apps", jurisdiction: "eu" }],
                    });
                  }),
                baseline: () => Effect.succeed([{ versionId: "previous", percentage: 100 }]),
                upload: (worker) =>
                  Effect.sync(() => {
                    assert.equal(api.writes, 0);
                    assert.equal(api.rollouts, 0);
                    events.push(`admit:${worker.id}`);
                    if (
                      worker.id === "Router" &&
                      ["late-worker-rejection", "new-ready-late-rejection"].includes(scenario)
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
        );
        assert.equal(
          publications.length,
          1,
          "publication survives later preparation or admission failure",
        );
        assert.equal(publications[0].inputHash, staged.proposed.hash.image);
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
          "same-digest",
          "dependency-only",
          "new-runtime-ready",
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
          assert.equal(
            api.writes,
            ["same-digest", "same-digest-unhealthy", "dependency-only"].includes(scenario) ? 0 : 1,
          );
          assert.equal(
            api.rollouts,
            ["same-digest", "same-digest-unhealthy", "dependency-only"].includes(scenario) ? 0 : 1,
          );
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
          if (scenario === "new-runtime-ready") {
            const ready = events.indexOf("command:node verify-database-budget.ts --ready");
            assert.ok(ready > events.indexOf("container:serving"));
            assert.equal(
              events.filter((event) => event === "command:node verify-database-budget.ts --ready")
                .length,
              1,
            );
          }
          assert.equal(receipts.at(-1).phase, "complete");
          attachmentPending = false;
          const next = yield* run(Plan.make(stack));
          unchangedAction = next.resources.PoolContainer.action;
          assert.equal(unchangedAction, "noop");
        } else if (["unhealthy-serving", "same-digest-unhealthy"].includes(scenario)) {
          assert.equal(api.writes, scenario === "unhealthy-serving" ? 1 : 0);
          assert.equal(api.rollouts, scenario === "unhealthy-serving" ? 1 : 0);
          assert.equal(receipts.at(-1).pendingContainer.phase, "verification");
          const saved = yield* memory.get({
            stack: stack.name,
            stage: stack.stage,
            fqn: "PoolContainer",
          });
          assert.equal(saved.attr.configuration.image, staged.previous.configuration.image);
          assert.equal(saved.attr.version, staged.previous.version);
          assert.equal(saved.attr.hash.image, staged.previous.hash.image);
        } else {
          assert.equal(api.writes, 0);
          assert.equal(api.rollouts, 0);
          assert.ok(!events.some((event) => event.startsWith("activate:")));
          if (
            [
              "late-worker-rejection",
              "new-ready-late-rejection",
              "missing-startup",
              "over-ceiling",
            ].includes(scenario)
          ) {
            assert.ok(!events.some((event) => event.startsWith("command:")));
            assert.equal(writes, 0);
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
