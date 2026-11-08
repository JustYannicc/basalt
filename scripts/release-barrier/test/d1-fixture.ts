import { publicSiteWaitlist, provisionPublicSiteWaitlist } from "../public-site-waitlist.ts";
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
import { nativeD1Provider } from "./native-d1-provider.ts";
import type { Database } from "alchemy/Cloudflare/D1";
import type { Worker } from "alchemy/Cloudflare";
import { Context, Effect, Layer, Option } from "effect";
import { decodeDeclaredChanges } from "../declared-change-schema.ts";
import type { DeclaredReadiness } from "../declared-prerequisites.ts";
import { deployStack, type DeployStackOptions } from "../deploy-stack.ts";
import { withReleaseRuntime } from "../runtime.ts";
import { attributes, preparedUpload } from "../fixture.ts";

export const databaseIntent = {
  schemaVersion: 1,
  stack: "fixture",
  retentionOwner: "Fixture storage owner",
  changes: [
    {
      action: "create-d1-database",
      type: "Cloudflare.D1Database",
      fqn: "PublicSiteWaitlist",
      props: { name: "public-site-waitlist", jurisdiction: "eu" },
      removalPolicy: "retain",
      retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
    },
  ],
};
interface FixtureWorker extends Resource<
  "Cloudflare.Worker",
  { revision: string; database?: string },
  Worker["Attributes"]
> {}
const FixtureWorker = Resource<FixtureWorker>("Cloudflare.Worker");
interface FixtureDatabase extends Resource<
  "Cloudflare.D1Database",
  Database["Props"],
  Database["Attributes"]
> {}
const FixtureDatabase = Resource<FixtureDatabase>("Cloudflare.D1Database");

export function provisioningD1(
  options: {
    nativeD1?: boolean;
    recoveredForeign?: boolean;
    plannedName?: string;
    plannedJurisdiction?: "us" | "default";
    undeclared?: boolean;
    missingPermission?: boolean;
    rejectedUpload?: boolean;
    createLostReply?: boolean;
    readFailsOnce?: boolean;
    resume?: boolean;
    retryUnknown?: boolean;
    collision?: boolean;
    featureBinding?: boolean;
    laterBinding?: boolean;
    lateDrift?: "missing" | "identity" | "jurisdiction";
    lostRow?: boolean;
    removeDeclaration?: boolean;
    multiple?: boolean;
    recordFails?: boolean;
  } = {},
) {
  const events: string[] = [];
  const progress: Parameters<NonNullable<DeployStackOptions["declared"]>>[0][] = [];
  const readiness: DeclaredReadiness[] = [];
  const bindings: unknown[] = [];
  let stored: Database["Attributes"] | undefined;
  let failedRead = false;
  let databaseResource: Pick<Database, "databaseId"> | undefined;
  let declarations = options.undeclared
    ? undefined
    : decodeDeclaredChanges({
        ...databaseIntent,
        changes: options.multiple
          ? [
              ...databaseIntent.changes,
              {
                ...databaseIntent.changes[0],
                fqn: "ArchiveWaitlist",
                props: { name: "archive-waitlist", jurisdiction: "eu" },
              },
            ]
          : databaseIntent.changes,
      });
  const workers = Provider.succeed(FixtureWorker, {
    diff: () => Effect.succeed({ action: "update" }),
    reconcile: ({ id, news }) =>
      Effect.gen(function* () {
        const hook = yield* Effect.serviceOption(WorkerUploadHook);
        if (Option.isNone(hook)) return attributes(id);
        const upload = preparedUpload(id);
        if (news.database) {
          assert.equal(news.database, "11111111-1111-4111-8111-111111111111");
          upload.request.metadata.bindings = [
            { type: "d1", name: "WAITLIST", databaseId: news.database },
          ];
          bindings.push(upload.request.metadata.bindings);
        }
        return yield* hook.value.capture({
          ...upload,
          activate: () =>
            Effect.sync(() => {
              events.push("activate");
              return attributes(id);
            }),
        });
      }),
    delete: () => Effect.die("Worker deletion forbidden"),
  });
  const databases = Provider.succeed(FixtureDatabase, {
    diff: () => Effect.succeed({ action: "noop" }),
    reconcile: () => Effect.die("Ordinary D1 reconciliation may adopt; forbidden"),
    delete: () => Effect.die("D1 deletion forbidden"),
  });
  let drift: () => Promise<void> = async () => {};
  const commands = Command.ExecProvider().pipe(
    Layer.provide(
      Layer.succeed(Command.CommandExecutor, {
        spawn: () => Effect.die("No child processes"),
        run: () =>
          Effect.promise(async () => {
            if (stored && options.lateDrift) await drift();
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
        options.nativeD1
          ? nativeD1Provider(() =>
              stored && options.recoveredForeign
                ? { ...stored, databaseId: "22222222-2222-4222-8222-222222222222" }
                : stored,
            )
          : databases,
        commands,
      ),
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      yield* Command.Exec("PoolDatabase", { command: "node ensure-pool-database.ts", memo: false });
      const database = options.nativeD1
        ? yield* provisionPublicSiteWaitlist
        : yield* FixtureDatabase("PublicSiteWaitlist", {
            name: options.plannedName ?? "public-site-waitlist",
            jurisdiction: options.plannedJurisdiction ?? "eu",
          }).pipe(RemovalPolicy.retain());
      databaseResource = database;
      if (options.multiple)
        yield* FixtureDatabase("ArchiveWaitlist", {
          name: "archive-waitlist",
          jurisdiction: "eu",
        }).pipe(RemovalPolicy.retain());
      return yield* FixtureWorker("PublicSite", {
        revision: "baseline-compatible",
        ...(options.featureBinding ? { database: database.databaseId } : {}),
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
              .filter(([, node]) => node.resource.Type !== "Cloudflare.D1Database")
              .map(([id, node]) =>
                id === "PublicSite"
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
        const scope = { stack: compiled.name, stage: compiled.stage };
        drift = async () => {
          if (options.lateDrift === "missing") stored = undefined;
          else if (options.lateDrift === "jurisdiction" && stored)
            stored = { ...stored, jurisdiction: "default" };
          else {
            const row = await Effect.runPromise(state.get({ ...scope, fqn: "PublicSiteWaitlist" }));
            assert.ok(row);
            await Effect.runPromise(
              state.set({
                ...scope,
                fqn: "PublicSiteWaitlist",
                value: { ...row, instanceId: "f".repeat(32) },
              }),
            );
          }
        };
        const releaseOptions = (): DeployStackOptions => ({
          candidate: "a".repeat(40),
          declarations,
          declared: async (value) => {
            progress.push(structuredClone(value));
            if (options.recordFails && value.outcome === "pending")
              throw new Error("private-evidence-error");
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
                if (options.rejectedUpload) throw new Error("synthetic rejected upload");
                return { versionId: "candidate", startupTimeMs: 1 };
              }),
            d1: {
              accountId: async () => "fixture",
              preflight: async () => {
                events.push("preflight-d1");
                if (options.missingPermission)
                  throw Object.assign(new Error("private-token-error"), { status: 403 });
              },
              exists: async () => options.collision === true,
              create: async (target) => {
                events.push("create-d1");
                stored = {
                  ...target,
                  databaseId: "11111111-1111-4111-8111-111111111111",
                  readReplication: undefined,
                  migrationsDir: undefined,
                  migrationsTable: undefined,
                  migrationsHashes: {},
                  importHashes: {},
                };
                if (options.createLostReply) throw new Error("synthetic lost create reply");
                return stored.databaseId;
              },
              read: async () => {
                if (stored && options.readFailsOnce && !failedRead) {
                  failedRead = true;
                  throw new Error("synthetic observation failure");
                }
                return stored;
              },
            },
          },
        });
        const deploy = () =>
          deployStack(compiled, releaseOptions()).pipe(Effect.provideContext(compiled.services));
        if (options.resume || options.retryUnknown) {
          const first = yield* Effect.exit(deploy());
          assert.equal(first._tag, "Failure");
        }
        yield* deploy();
        if (options.lostRow) {
          yield* state.delete({ ...scope, fqn: "PublicSiteWaitlist" });
          stored = undefined;
          yield* deploy();
        }
        if (options.laterBinding) {
          assert.ok(databaseResource);
          const worker = compiled.resources.PublicSite!;
          compiled.resources.PublicSite = {
            ...worker,
            Props: { ...worker.Props, database: (yield* publicSiteWaitlist).databaseId },
          };
          yield* deploy();
        }
        if (options.removeDeclaration) {
          declarations = undefined;
          yield* deploy();
        }
        return yield* state.get({ ...scope, fqn: "PublicSiteWaitlist" });
      }).pipe(Effect.provideService(State, Context.get(compiled.services, State))),
    { stage: "production" },
  ).pipe(withReleaseRuntime);
  return { effect, events, progress, readiness, bindings };
}
