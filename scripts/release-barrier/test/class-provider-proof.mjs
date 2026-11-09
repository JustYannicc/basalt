import assert from "node:assert/strict";
import { Effect, ConfigProvider, Context } from "effect";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack, evalStack } from "alchemy/Stack";
import { inMemoryState } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import { findProvider } from "alchemy/Provider";
import { scopedArtifacts } from "alchemy/Artifacts";
import { WorkerUploadHook } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { withReleaseRuntime } from "../runtime.ts";
import { attributes } from "../fixture.ts";
import { classRequestVerdict } from "../declared-class-contract.ts";
import { freezeUpload } from "../version-request.ts";

const accountId = "0".repeat(32),
  scriptName = "fixture-worker";
let settings = { bindings: [], tags: [], logpush: false };
const calls = [];
const wire = (value) =>
  Array.isArray(value)
    ? value.map(wire)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key.replace(/[A-Z]/g, (char) => "_" + char.toLowerCase()),
            wire(item),
          ]),
        )
      : value;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  calls.push(`${request.method}:${path}`);
  assert.equal(request.method, "GET", "Native capture must never write or precreate");
  let result;
  if (path.endsWith("/settings")) result = wire(settings);
  else if (path.endsWith("/subdomain")) result = { enabled: false, previews_enabled: false };
  else if (path.endsWith("/schedules")) result = { schedules: [] };
  else if (path.endsWith("/domains")) result = [];
  else throw new Error(`Unexpected native fixture GET ${path}`);
  return Response.json({ success: true, errors: [], messages: [], result });
};

const baseline = {
  name: scriptName,
  script: "export default {};",
  workersDev: false,
  compatibility: { date: "2026-09-08" },
};
const entry = {
  action: "add-sqlite-class",
  type: "Cloudflare.Worker",
  fqn: "Fixture",
  newSqliteClasses: ["DriveObject"],
  addedBindings: [
    {
      type: "durable_object_namespace",
      name: "DRIVE",
      className: "DriveObject",
      location: "local",
    },
  ],
  retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
};
const program = evalStack(
  Stack(
    "fixture",
    { providers: Cloudflare.providers(), state: inMemoryState() },
    Cloudflare.Worker("Fixture", baseline),
  ),
  (compiled) =>
    Effect.gen(function* () {
      const provider = yield* findProvider(Cloudflare.Worker);
      const base = {
        id: "Fixture",
        fqn: "Fixture",
        instanceId: "fixture-instance",
        news: baseline,
        olds: baseline,
        bindings: [],
        output: { ...attributes("Fixture"), accountId, workerName: scriptName },
        session: { note: () => Effect.void, emit: () => Effect.void },
      };
      const capture = (input) =>
        Effect.gen(function* () {
          let captured;
          yield* provider.reconcile(input).pipe(
            Effect.provideService(WorkerUploadHook, {
              capture: (upload) =>
                Effect.sync(() => {
                  captured = upload;
                  return upload.proposed;
                }),
            }),
          );
          assert.ok(captured);
          return captured;
        });
      const initial = yield* capture(base);
      settings = {
        ...initial.request.metadata,
        bindings: [],
        tags: [...initial.request.metadata.tags, "alchemy:migration-tag:alchemy:v1"],
      };
      delete settings.migrations;
      delete settings.mainModule;
      const input = {
        ...base,
        news: {
          ...baseline,
          script:
            "import { DurableObject } from 'cloudflare:workers'; export class DriveObject extends DurableObject {} export default {};",
        },
        bindings: [
          {
            sid: "DriveObject",
            data: {
              bindings: [
                { type: "durable_object_namespace", name: "DRIVE", className: "DriveObject" },
              ],
            },
          },
        ],
      };
      const before = yield* capture(input);
      const verdict = classRequestVerdict(before, entry);
      assert.equal(verdict.oldTag, "alchemy:v1");
      assert.equal(verdict.newTag, "alchemy:v2");
      assert.deepEqual(verdict.newSqliteClasses, ["DriveObject"]);
      settings = {
        ...settings,
        tags: before.request.metadata.tags,
        bindings: [
          {
            type: "durable_object_namespace",
            name: "DRIVE",
            className: "DriveObject",
            namespaceId: "namespace-drive",
          },
        ],
      };
      const after = yield* capture({
        ...input,
        output: {
          ...base.output,
          tags: settings.tags,
          durableObjectNamespaces: { DriveObject: "namespace-drive" },
        },
      });
      assert.deepEqual(after.request.metadata.migrations.newSqliteClasses, []);
      const frozen = yield* Effect.promise(() =>
        freezeUpload(after, [{ versionId: "expanded", percentage: 100 }]),
      );
      assert.equal(frozen.metadata.migrations, undefined);
      assert.ok(
        frozen.metadata.bindings.some(
          (binding) =>
            binding.type === "durable_object_namespace" && binding.className === "DriveObject",
        ),
      );
      return {
        oldTag: verdict.oldTag,
        newTag: verdict.newTag,
        classNames: verdict.newSqliteClasses,
        reads: calls.length,
      };
    }).pipe(
      Effect.provide(scopedArtifacts("Fixture")),
      Effect.provideContext(compiled.services),
      Effect.provideService(State, Context.get(compiled.services, State)),
    ),
  { stage: "production" },
).pipe(
  withReleaseRuntime,
  Effect.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          CLOUDFLARE_ACCOUNT_ID: accountId,
          CLOUDFLARE_API_TOKEN: "synthetic-never-sent",
          ALCHEMY_STAGE: "production",
        },
      }),
    ),
  ),
);
console.log("__CLASS_PROOF__" + JSON.stringify(await Effect.runPromise(program)));
