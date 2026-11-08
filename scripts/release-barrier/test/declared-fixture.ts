import { retainedRemovedBucket, driftNativeProvider } from "./declared-state.ts";
import { nativeBucketProvider } from "./native-bucket-provider.ts";
import assert from "node:assert/strict";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Command from "alchemy/Command";
import * as Provider from "alchemy/Provider";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import { Resource } from "alchemy/Resource";
import { Stack, evalStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { WorkerUploadHook } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { Bucket } from "alchemy/Cloudflare/R2";
import type { Worker } from "alchemy/Cloudflare";
import { Context, Effect, Layer, Option } from "effect";
import { decodeDeclaredChanges } from "../declared-change-schema.ts";
import type { DeclaredReadiness } from "../declared-prerequisites.ts";
import type { BucketProgress } from "../declared-buckets.ts";
import { deployStack, type DeployStackOptions } from "../deploy-stack.ts";
import { withReleaseRuntime } from "../runtime.ts";
import { attributes, preparedUpload } from "../fixture.ts";

const bucketProps = {
  jurisdiction: "eu",
  storageClass: "Standard",
  publicAccess: false,
  forceDestroy: false,
  domains: [],
  cors: [],
  lifecycleRules: [],
} satisfies Bucket["Props"];
const declarations = decodeDeclaredChanges({
  schemaVersion: 1,
  stack: "fixture",
  retentionOwner: "Fixture storage owner",
  changes: [
    {
      action: "create-bucket",
      type: "Cloudflare.R2.Bucket",
      fqn: "DriveRecords",
      props: bucketProps,
      removalPolicy: "retain",
      retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
    },
  ],
});
interface FixtureWorker extends Resource<
  "Cloudflare.Worker",
  { revision: string; bucket?: string; extraBucket?: string },
  Worker["Attributes"]
> {}
const FixtureWorker = Resource<FixtureWorker>("Cloudflare.Worker");
interface FixtureBucket extends Resource<
  "Cloudflare.R2.Bucket",
  Bucket["Props"],
  Bucket["Attributes"]
> {}
const FixtureBucket = Resource<FixtureBucket>("Cloudflare.R2.Bucket");

export function provisioning(
  options: {
    lostRow?: boolean;
    missingPrerequisite?: boolean;
    lateDrift?: "missing" | "identity";
    rejectedUpload?: boolean;
    createLostReply?: boolean;
    readFailsOnce?: boolean;
    resume?: boolean;
    retryUnknown?: boolean;
    collision?: boolean;
    featureBinding?: boolean;
    providerError?: boolean;
    accountError?: boolean;
    nativeBucket?: boolean;
    multipleMissing?: boolean;
    recoveredForeign?: boolean;
    recordFails?: boolean;
    orphanedHistory?: boolean;
    nativeProviderDrift?: boolean;
    rejectedAfterAcknowledgement?: boolean;
  } = {},
) {
  const events: string[] = [];
  const progress: BucketProgress[] = [];
  const readiness: DeclaredReadiness[] = [];
  let mutateAfterDatabase: () => Promise<void> = async () => {};
  let stored: Bucket["Attributes"] | undefined;
  let failedRead = false;
  const workers = Provider.succeed(FixtureWorker, {
    diff: () => Effect.succeed({ action: "update" }),
    reconcile: ({ id }) =>
      Effect.gen(function* () {
        const hook = yield* Effect.serviceOption(WorkerUploadHook);
        if (Option.isNone(hook)) return attributes(id);
        return yield* hook.value.capture({
          ...preparedUpload(id),
          activate: () =>
            Effect.sync(() => {
              events.push("activate");
              return attributes(id);
            }),
        });
      }),
    delete: () => Effect.die("Worker deletion forbidden"),
  });
  const buckets = Provider.succeed(FixtureBucket, {
    diff: () => Effect.succeed({ action: "noop" }),
    reconcile: () => Effect.die("Ordinary bucket reconciliation may adopt; forbidden"),
    delete: () => Effect.die("Bucket deletion forbidden"),
  });
  const commands = Command.ExecProvider().pipe(
    Layer.provide(
      Layer.succeed(Command.CommandExecutor, {
        spawn: () => Effect.die("No child processes"),
        run: () =>
          Effect.promise(async () => {
            if (stored && options.lateDrift) await mutateAfterDatabase();
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
        options.nativeBucket
          ? nativeBucketProvider(() =>
              stored && options.recoveredForeign
                ? { ...stored, bucketName: "foreign-bucket" }
                : stored,
            )
          : buckets,
        commands,
      ),
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      yield* Command.Exec("PoolDatabase", { command: "node ensure-pool-database.ts", memo: false });
      const bucket = options.nativeBucket
        ? yield* Bucket("DriveRecords", bucketProps).pipe(RemovalPolicy.retain())
        : yield* FixtureBucket("DriveRecords", bucketProps).pipe(RemovalPolicy.retain());
      const extra = options.multipleMissing
        ? yield* FixtureBucket("ArchiveRecords", bucketProps).pipe(RemovalPolicy.retain())
        : undefined;
      return yield* FixtureWorker("AppData", {
        revision: "baseline-compatible",
        ...(options.featureBinding ? { bucket: bucket.bucketName } : {}),
        ...(extra ? { extraBucket: extra.bucketName } : {}),
      });
    }),
  );
  const effect = evalStack(
    stack,
    (compiled) =>
      Effect.gen(function* () {
        const baseline = yield* Plan.make(compiled);
        yield* Apply.apply({
          ...baseline,
          resources: Object.fromEntries(
            Object.entries(baseline.resources)
              .filter(([, node]) => node.resource.Type !== "Cloudflare.R2.Bucket")
              .map(([id, node]) =>
                id === "AppData"
                  ? [
                      id,
                      {
                        ...node,
                        action: "create",
                        props: { revision: "baseline-compatible" },
                        resource: { ...node.resource, Props: { revision: "baseline-compatible" } },
                        bindings: [],
                        downstream: [],
                      },
                    ]
                  : [id, node],
              ),
          ),
        });
        events.length = 0;
        const state = yield* yield* State;
        if (options.orphanedHistory)
          yield* retainedRemovedBucket({ stack: compiled.name, stage: compiled.stage });
        mutateAfterDatabase = async () => {
          if (options.lateDrift === "missing") stored = undefined;
          else {
            const current = await Effect.runPromise(
              state.get({ stack: compiled.name, stage: compiled.stage, fqn: "DriveRecords" }),
            );
            assert.ok(current);
            await Effect.runPromise(
              state.set({
                stack: compiled.name,
                stage: compiled.stage,
                fqn: "DriveRecords",
                value: { ...current, instanceId: "f".repeat(32) },
              }),
            );
          }
        };
        const releaseOptions = {
          candidate: "a".repeat(40),
          declarations: options.multipleMissing
            ? decodeDeclaredChanges({
                ...declarations,
                changes: [
                  ...declarations.changes,
                  { ...declarations.changes[0], fqn: "ArchiveRecords" },
                ],
              })
            : declarations,
          declared: async (value) => {
            if ("bucket" in value) progress.push(structuredClone(value));
            if (options.recordFails && value.outcome === "pending")
              throw Object.assign(new Error("private-evidence-error"), { status: 500, code: 9001 });
          },
          declaredReadiness: async (value) => {
            readiness.push(structuredClone(value));
          },
          record: async (receipt) => {
            if (receipt.phase === "admitted") events.push("admitted");
          },
          manifest: async () => {},
          io: {
            baseline: () => Effect.succeed([{ versionId: "previous", percentage: 100 }]),
            upload: () =>
              Effect.sync(() => {
                events.push("upload");
                if (options.rejectedUpload || (options.rejectedAfterAcknowledgement && failedRead))
                  throw new Error("synthetic rejection");
                return { versionId: "accepted", startupTimeMs: 100 };
              }),
            buckets: {
              accountId: async () => {
                if (options.accountError) throw new Error("private-account-failure");
                return "fixture";
              },
              read: async (target) => {
                if (options.providerError)
                  throw Object.assign(new Error("private-provider-detail"), {
                    status: 403,
                    code: 10000,
                  });
                if (stored && options.readFailsOnce && !failedRead) {
                  failedRead = true;
                  throw new Error("synthetic observation failure");
                }
                return options.collision
                  ? {
                      attributes: {
                        ...target,
                        location: undefined,
                        domains: [],
                        cors: [],
                        lifecycleRules: [],
                        publicDomain: undefined,
                      },
                      publicAccess: false,
                    }
                  : stored === undefined
                    ? undefined
                    : { attributes: stored, publicAccess: false };
              },
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
                if (options.createLostReply) throw new Error("synthetic lost create reply");
              },
            },
          },
        } satisfies DeployStackOptions;
        if (options.resume || options.retryUnknown) {
          const first = yield* Effect.exit(
            deployStack(compiled, releaseOptions).pipe(Effect.provideContext(compiled.services)),
          );
          assert.ok(first._tag === "Failure");
        }
        if (options.nativeProviderDrift)
          yield* driftNativeProvider({ stack: compiled.name, stage: compiled.stage });
        yield* deployStack(compiled, releaseOptions).pipe(Effect.provideContext(compiled.services));
        if (options.lostRow) {
          yield* state.delete({ stack: compiled.name, stage: compiled.stage, fqn: "DriveRecords" });
          stored = undefined;
          yield* deployStack(compiled, releaseOptions).pipe(
            Effect.provideContext(compiled.services),
          );
        }
        if (options.missingPrerequisite) {
          stored = undefined;
          yield* deployStack(compiled, releaseOptions).pipe(
            Effect.provideContext(compiled.services),
          );
        }
        return yield* state.get({
          stack: compiled.name,
          stage: compiled.stage,
          fqn: "DriveRecords",
        });
      }).pipe(Effect.provideService(State, Context.get(compiled.services, State))),
    { stage: "production" },
  ).pipe(withReleaseRuntime);
  return { effect, events, progress, readiness };
}
