import assert from "node:assert/strict";
import { Effect, Context, Layer, Redacted, ConfigProvider, Cause } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import * as HttpRequest from "effect/http/HttpClientRequest";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { Stack, evalStack } from "alchemy/Stack";
import { poolObservationStore } from "../../../src/pool/fleet-observation.ts";
import { withReleaseRuntime } from "../runtime.ts";
import { planObservationStore } from "../observation-store-plan.ts";
import {
  runDeclaredProvisioning,
  inspectDeclaredProvisioning,
  provisioningOperationDigest,
} from "../provisioning-operation.ts";
import { observationStoreClient } from "../observation-store-wire.ts";
const tree = process.argv[2];
const load = (name) =>
  import(
    new URL(
      `../../../node_modules/alchemy/${tree}/${name}.${tree === "src" ? "ts" : "js"}`,
      import.meta.url,
    )
  );
const [{ Store, StoreProviderLive }, { State }, { InMemoryService }, { CloudflareEnvironment }] =
  await Promise.all([
    load("Cloudflare/SecretsStore/SecretsStore"),
    load("State/State"),
    load("State/InMemoryState"),
    load("Cloudflare/CloudflareEnvironment"),
  ]);
globalThis.fetch = () => {
  throw new Error("REAL NETWORK DENIED");
};
const accountId = "1".repeat(32),
  candidate = "a".repeat(40),
  fqn = "PoolObservationSecrets";
const writer = { accountId, candidate, lease: "synthetic-production-lock" };
const readGo = {
  kind: "observation-store",
  operationId: "synthetic-only",
  coordinatorGo: "test-read-GO",
  expiresAt: 1000,
};

function wire(options = {}) {
  const calls = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      calls.push({ method: request.method, path: url.pathname });
      assert.equal(request.method, "GET", "provider mutation escaped the guard");
      assert.equal(url.pathname, `/client/v4/accounts/${accountId}/secrets_store/stores`);
      const absent = options.missing || (options.disappear && calls.length >= 3);
      const result = absent
        ? []
        : [
            {
              id: options.changed && calls.length >= 3 ? "changed" : "synthetic-store",
              name: "default_secrets_store",
              account_id: accountId,
              created: "2026-01-01T00:00:00Z",
              modified: "2026-01-01T00:00:00Z",
            },
          ];
      return HttpResponse.fromWeb(
        request,
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result,
          result_info: {
            page: 1,
            per_page: 50,
            count: result.length,
            total_count: result.length,
            total_pages: 1,
          },
        }),
      );
    }),
  );
  return { client, calls };
}
async function scenario(options = {}) {
  const old = {
    status: "created",
    fqn: "Unrelated",
    logicalId: "Unrelated",
    resourceType: "Cloudflare.Worker",
    instanceId: "existing",
    props: { image: "unchanged" },
    attr: { live: true },
    bindings: [],
    downstream: [],
    providerVersion: 0,
  };
  const rows = { basalt: { production: { Unrelated: structuredClone(old) } } };
  const outputs = {
    basalt: { production: { deployed: "keep-this" } },
    "basalt-release-barrier": { production: { schemaVersion: 1, complete: true } },
  };
  const memory = await Effect.runPromise(InMemoryService(rows, outputs));
  let writes = 0,
    journalRecord;
  const tracked = {
    ...memory,
    set: (input) => {
      writes++;
      return memory.set(input);
    },
  };
  const stack = Stack(
    "basalt",
    { providers: StoreProviderLive(), state: Layer.succeed(State, Effect.succeed(tracked)) },
    Effect.gen(function* () {
      yield* poolObservationStore();
      return undefined;
    }),
  );
  const w = wire(options);
  const program = evalStack(
    stack,
    (compiled) =>
      Effect.gen(function* () {
        const state = yield* yield* State;
        const manifest = yield* planObservationStore(
          compiled,
          options.readGo ?? readGo,
          writer,
          () => 100,
        );
        assert.equal(writes, 0, "read-only planning persisted synthetic adoption");
        assert.equal(yield* state.get({ stack: "basalt", stage: "production", fqn }), undefined);
        const operation = {
          kind: "observation-store",
          manifest: options.manifest ? { ...manifest, ...options.manifest } : manifest,
        };
        const packet = {
          operation,
          go: {
            coordinatorGo: "test-apply-GO",
            manifest: provisioningOperationDigest(operation),
            expiresAt: options.expired ? 100 : 1000,
          },
        };
        const store = {
          exclusive: (work) => work(),
          read: async () => journalRecord,
          write: async (record) => {
            journalRecord = structuredClone(record);
          },
        };
        // The public operation uses the native encrypted journal. This adapter test replaces only its persistence transport.
        const { provisionObservationStore } = yield* Effect.promise(
          () => import("../observation-store-apply.ts"),
        );
        const { validateProvisioningOperation } = yield* Effect.promise(
          () => import("../provisioning-operation.ts"),
        );
        const enable = validateProvisioningOperation(packet, writer, 100);
        const perform = options.publicOperation
          ? runDeclaredProvisioning(compiled, packet, writer, "b".repeat(64), "", {
              now: () => 100,
            })
          : provisionObservationStore(compiled, {
              manifest: operation.manifest,
              enable,
              store,
              now: () => 100,
            });
        if (options.disappear || options.changed) {
          const first = yield* Effect.exit(perform);
          assert.equal(first._tag, "Failure");
          const before = { calls: w.calls.length, writes };
          const second = yield* Effect.exit(perform);
          assert.equal(second._tag, "Failure");
          assert.deepEqual(
            { calls: w.calls.length, writes },
            before,
            "unknown operation replay sent again",
          );
          return yield* Effect.failCause(first.cause);
        }
        const receipt = yield* perform;
        assert.equal(receipt.action, "noop");
        assert.equal(receipt.barrier, "PASS");
        if (options.publicOperation) {
          const inspection = yield* inspectDeclaredProvisioning(
            compiled,
            packet,
            writer,
            "b".repeat(64),
          );
          assert.equal(inspection.complete, true);
          assert.equal(inspection.resource, fqn);
          assert.deepEqual(outputs["basalt-release-barrier"].production.previous, {
            schemaVersion: 1,
            complete: true,
          });
        } else assert.equal(journalRecord.complete, true);
        assert.equal(rows.basalt.production[fqn].status, "updated");
        const before = writes;
        yield* perform;
        assert.equal(writes, before, "acknowledged replay applied again");
        return receipt;
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, w.client),
        Effect.provideService(
          Credentials,
          Effect.succeed({
            type: "apiToken",
            apiToken: Redacted.make("synthetic-only"),
            apiBaseUrl: "https://api.cloudflare.com/client/v4",
          }),
        ),
        Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId })),
        Effect.provideContext(compiled.services),
        Effect.provideService(State, Context.get(compiled.services, State)),
      ),
    { stage: "production" },
  ).pipe(
    withReleaseRuntime,
    Effect.provideService(HttpClient.HttpClient, w.client),
    Effect.provideService(
      Credentials,
      Effect.succeed({
        type: "apiToken",
        apiToken: Redacted.make("synthetic-only"),
        apiBaseUrl: "https://api.cloudflare.com/client/v4",
      }),
    ),
    Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId })),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { CLOUDFLARE_ACCOUNT_ID: accountId } })),
    ),
  );
  const exit = await Effect.runPromise(Effect.exit(program));
  assert.deepEqual(rows.basalt.production.Unrelated, old);
  assert.deepEqual(outputs.basalt.production, { deployed: "keep-this" });
  return { exit, calls: w.calls, writes, rows, journalRecord };
}
const good = await scenario();
if (good.exit._tag === "Failure") console.error(Cause.pretty(good.exit.cause));
assert.equal(good.exit._tag, "Success");
assert.ok(good.writes >= 2);
const publicResult = await scenario({ publicOperation: true });
if (publicResult.exit._tag === "Failure") console.error(Cause.pretty(publicResult.exit.cause));
assert.equal(publicResult.exit._tag, "Success");
const missing = await scenario({ missing: true });
assert.equal(missing.exit._tag, "Failure");
assert.equal(missing.writes, 0);
for (const options of [{ disappear: true }, { changed: true }]) {
  const result = await scenario(options);
  assert.equal(result.exit._tag, "Failure");
  assert.equal(result.journalRecord.operations["store-adopt"].outcome, "unknown");
  assert.equal(result.rows.basalt.production[fqn].status, "updating");
}
for (const options of [
  { readGo: { ...readGo, expiresAt: 100 } },
  { expired: true },
  { manifest: { sdkSourceDigest: "b".repeat(64) } },
  { manifest: { absentRowDigest: "b".repeat(64) } },
  { manifest: { storeId: "different" } },
]) {
  const result = await scenario(options);
  assert.equal(result.exit._tag, "Failure");
  assert.equal(result.writes, 0);
}
const w = wire();
const guarded = observationStoreClient(w.client, accountId);
for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  const result = await Effect.runPromise(
    Effect.exit(
      guarded.execute(
        HttpRequest.make(method)(
          `https://api.cloudflare.com/client/v4/accounts/${accountId}/secrets_store/stores`,
        ),
      ),
    ),
  );
  assert.equal(result._tag, "Failure");
}
assert.equal(w.calls.length, 0);
console.log("__OBSERVATION_STORE_PROOF_PASS__");
