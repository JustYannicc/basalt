import { classCompanion, type CompanionMode } from "./class-companion.ts";
import { retirePlacement } from "../placement-retirement.ts";
import assert from "node:assert/strict";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import * as Command from "alchemy/Command";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Resource } from "alchemy/Resource";
import type { Worker } from "alchemy/Cloudflare";
import type { Bucket } from "alchemy/Cloudflare/R2";
import { Stack, evalStack } from "alchemy/Stack";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import { WorkerUploadHook } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { Cause, Context, Effect, Exit, Layer, Option, Redacted } from "effect";
import { preparedUpload } from "../fixture.ts";
import { decodeDeclaredChanges } from "../declared-change-schema.ts";
import { deployStack, type DeployStackOptions } from "../deploy-stack.ts";
import { withReleaseRuntime } from "../runtime.ts";
import { classApi, classRecoveryClient, type ClassApiOptions } from "./class-api.ts";
import type { ClassProgress } from "../declared-class-contract.ts";
import { describeWorker, canonical, digest, type ReleaseManifest } from "../manifest.ts";
import type { BarrierReceipt } from "../barrier.ts";
import type { releaseEvidence } from "../evidence.ts";
import { recoverStack } from "../recover-stack.ts";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as HttpClient from "effect/http/HttpClient";

interface TestWorker extends Resource<"Cloudflare.Worker", {}, Worker["Attributes"]> {}
const TestWorker = Resource<TestWorker>("Cloudflare.Worker");
interface TestBucket extends Resource<
  "Cloudflare.R2.Bucket",
  Bucket["Props"],
  Bucket["Attributes"]
> {}
const TestBucket = Resource<TestBucket>("Cloudflare.R2.Bucket");
const bucketProps = {
  jurisdiction: "eu",
  storageClass: "Standard",
  publicAccess: false,
  forceDestroy: false,
  domains: [],
  cors: [],
  lifecycleRules: [],
} satisfies Bucket["Props"];
const added = {
  type: "durable_object_namespace",
  name: "DRIVE",
  className: "DriveObject",
  location: "local",
} as const;

export function classProvisioning(
  options: ClassApiOptions & {
    reject?: boolean;
    rerun?: boolean;
    lateDrift?: boolean;
    expectedFailure?: RegExp;
    nativeDrift?: boolean;
    futureMissing?: boolean;
    deletedClass?: boolean;
    recordFails?: boolean;
    recover?: "pre-migration" | "compatible";
    evidence?: ReturnType<typeof releaseEvidence>;
    secondForeignWorker?: boolean;
    companion?: CompanionMode;
  } = {},
) {
  const events: string[] = [];
  const api = classApi(events, options);
  const companion = classCompanion(options.companion ?? "numeric", events);
  const progress: ClassProgress[] = [];
  const failures: unknown[] = [];
  const recoveryFailures: unknown[] = [];
  let manifest: ReleaseManifest | undefined;
  let receipt: BarrierReceipt | undefined;
  let stored: Bucket["Attributes"] | undefined;
  const workers = Provider.succeed(TestWorker, {
    diff: () => Effect.succeed({ action: "update" }),
    reconcile: ({ id }) =>
      Effect.gen(function* () {
        const hook = yield* Effect.serviceOption(WorkerUploadHook);
        if (Option.isNone(hook)) return api.attributes(id);
        const upload = preparedUpload(id);
        if (id === "Api" && companion)
          return yield* hook.value.capture(
            yield* companion.prepare({
              ...upload,
              activate: () =>
                Effect.sync(() => {
                  companion.activate();
                  return api.attributes(id);
                }),
            }),
          );
        const binding = {
          type: "durable_object_namespace",
          name: "DRIVE",
          className: "DriveObject",
        } as const;
        return yield* hook.value.capture({
          ...upload,
          previous: api.attributes(id),
          proposed: api.attributes(id),
          request: {
            ...upload.request,
            metadata: {
              ...upload.request.metadata,
              bindings: [binding],
              tags: [`alchemy:migration-tag:${api.expanded() ? 3 : 2}`],
              migrations: {
                oldTag: api.expanded() ? "2" : "1",
                newTag: api.expanded() ? "3" : "2",
                newSqliteClasses: api.expanded() ? [] : ["DriveObject"],
                ...(options.deletedClass ? { deletedClasses: ["ExistingClass"] } : {}),
              },
            },
          },
          previousSettings: api.settings(),
          activate: () =>
            Effect.sync(() => {
              events.push("activate");
              return api.attributes(id);
            }),
        });
      }),
    delete: () => Effect.die("No Worker deletion"),
  }).pipe(Layer.provide(companion.services));
  const commands = Command.ExecProvider().pipe(
    Layer.provide(
      Layer.succeed(Command.CommandExecutor, {
        spawn: () => Effect.die("No child processes"),
        run: () =>
          Effect.sync(() => {
            if (stored && options.lateDrift) api.removeNamespace();
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      }),
    ),
  );
  const stack = Stack(
    "fixture",
    {
      providers: Layer.mergeAll(
        workers,
        commands,
        Provider.succeed(TestBucket, {
          diff: () => Effect.succeed({ action: "noop" }),
          reconcile: () => Effect.die("No adopting bucket reconcile"),
          delete: () => Effect.die("No bucket deletion"),
        }),
      ),
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      yield* Command.Exec("PoolDatabase", { command: "node ensure-pool-database.ts", memo: false });
      yield* TestBucket("DriveRecords", bucketProps).pipe(RemovalPolicy.retain());
      if (options.companion) yield* TestWorker("Api", {});
      if (options.secondForeignWorker) yield* TestWorker("OtherData", {});
      return yield* TestWorker("AppData", {});
    }),
  );
  const originalDeclarations = decodeDeclaredChanges({
    schemaVersion: 1,
    stack: "fixture",
    retentionOwner: "Fixture owner",
    changes: [
      {
        action: "create-bucket",
        type: "Cloudflare.R2.Bucket",
        fqn: "DriveRecords",
        props: bucketProps,
        removalPolicy: "retain",
        retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
      },
      {
        action: "add-sqlite-class",
        type: "Cloudflare.Worker",
        fqn: "AppData",
        newSqliteClasses: ["DriveObject"],
        addedBindings: [added],
        retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
      },
    ],
  });
  const declarations = options.secondForeignWorker
    ? decodeDeclaredChanges({
        ...originalDeclarations,
        changes: [
          ...originalDeclarations.changes,
          {
            ...originalDeclarations.changes.find((entry) => entry.action === "add-sqlite-class")!,
            fqn: "OtherData",
          },
        ],
      })
    : originalDeclarations;
  const effect = evalStack(
    stack,
    (compiled) =>
      Effect.gen(function* () {
        const initial = yield* Plan.make(compiled);
        yield* Apply.apply({
          ...initial,
          resources: Object.fromEntries(
            Object.entries(initial.resources).filter(
              ([, node]) => node.resource.Type !== "Cloudflare.R2.Bucket",
            ),
          ),
        });
        events.length = 0;
        if (companion?.retired) {
          const state = yield* yield* State;
          yield* retirePlacement(state, compiled, "Api");
        }
        const release = {
          candidate: "a".repeat(40),
          declarations,
          declared: options.evidence?.declared ?? (async () => {}),
          declaredReadiness: options.evidence?.declaredReadiness ?? (async () => {}),
          expansion: async (value) => {
            progress.push(value);
            await options.evidence?.expansion(value);
            if (options.recordFails) throw new Error("Synthetic evidence write failure");
          },
          record: async (value) => {
            await options.evidence?.record(value);
            receipt = value;
          },
          manifest: async (value) => {
            await options.evidence?.manifest(value);
            manifest = value;
          },
          io: {
            baseline: (request) =>
              Effect.succeed(
                request.scriptName !== "AppData" && options.companion
                  ? companion.baseline(request.scriptName)
                  : [{ versionId: api.expanded() ? "expanded" : "previous", percentage: 100 }],
              ),
            ...(options.companion?.startsWith("numeric")
              ? { placements: () => companion!.placements() }
              : {}),
            upload: (worker) =>
              Effect.sync(() => {
                events.push("upload");
                if (options.reject) throw new Error("Synthetic admission refusal");
                return {
                  versionId: worker.id === "Api" ? "accepted-Api" : "accepted",
                  startupTimeMs: 100,
                };
              }),
            classes: api.provider,
            buckets: {
              accountId: async () => "fixture",
              read: async () => (stored ? { attributes: stored, publicAccess: false } : undefined),
              configure: async () => {},
              create: async (target) => {
                events.push("create-bucket");
                stored = {
                  ...target,
                  location: undefined,
                  domains: [],
                  cors: [],
                  lifecycleRules: [],
                  publicDomain: undefined,
                };
              },
            },
          },
        } satisfies DeployStackOptions;
        const attempt = Effect.gen(function* () {
          const result = yield* Effect.exit(
            deployStack(compiled, release).pipe(
              Effect.provide(companion.services),
              Effect.provideContext(compiled.services),
            ),
          );
          if (Exit.isFailure(result)) {
            const error = Cause.squash(result.cause);
            failures.push(error);
            if (options.expectedFailure) assert.match(String(error), options.expectedFailure);
            else if (options.reject) assert.match(String(error), /upload-rejected/);
            else throw error;
          } else if (options.reject || options.expectedFailure)
            assert.fail("Expected a refused release");
        });
        yield* attempt;
        if (options.rerun) {
          const state = yield* yield* State;
          if (options.nativeDrift) {
            const current = yield* state.get({
              stack: compiled.name,
              stage: compiled.stage,
              fqn: "AppData",
            });
            assert.ok(current);
            yield* state.set({
              stack: compiled.name,
              stage: compiled.stage,
              fqn: "AppData",
              value: { ...current, instanceId: "f".repeat(32) },
            });
          }
          if (options.futureMissing) api.removeNamespace();
          const second = yield* Effect.exit(
            deployStack(compiled, release).pipe(
              Effect.provide(companion.services),
              Effect.provideContext(compiled.services),
            ),
          );
          if (Exit.isFailure(second)) failures.push(Cause.squash(second.cause));
          else if (
            options.reject ||
            options.nativeDrift ||
            options.futureMissing ||
            options.loseReply
          )
            assert.fail("Expected the rerun to refuse");
        }
        if (options.recover) {
          assert.ok(manifest && receipt);
          const description = {
            candidate: manifest.candidate,
            stack: manifest.stack,
            stage: manifest.stage,
            workers: manifest.workers.map((worker) => ({
              ...describeWorker(worker),
              baseline: [
                {
                  versionId: options.recover === "pre-migration" ? "pre-expansion" : "expanded",
                  percentage: 100,
                },
              ],
            })),
          };
          const result = yield* Effect.exit(
            recoverStack(
              compiled,
              description,
              { ...receipt, manifest: digest(canonical(description)) },
              async () => {},
            ).pipe(
              Effect.provideService(HttpClient.HttpClient, classRecoveryClient(events)),
              Effect.provideService(
                Credentials,
                Effect.succeed({
                  type: "apiToken",
                  apiToken: Redacted.make("synthetic-never-sent"),
                  apiBaseUrl: "https://api.cloudflare.com/client/v4",
                }),
              ),
            ),
          );
          if (Exit.isFailure(result)) recoveryFailures.push(Cause.squash(result.cause));
        }
      }).pipe(Effect.provideService(State, Context.get(compiled.services, State))),
    { stage: "production" },
  ).pipe(withReleaseRuntime);
  return {
    effect,
    events,
    progress,
    failures,
    recoveryFailures,
    emptyClassSource: api.emptyClassSource,
    cloneState: api.cloneState,
  };
}
