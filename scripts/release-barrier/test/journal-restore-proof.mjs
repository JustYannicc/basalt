import assert from "node:assert/strict";
import { Effect, Layer, Redacted, ConfigProvider, Context, Cause } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { StoreProviderLive } from "../../../node_modules/alchemy/lib/Cloudflare/SecretsStore/SecretsStore.js";
import { State } from "../../../node_modules/alchemy/lib/State/State.js";
import { InMemoryService } from "../../../node_modules/alchemy/lib/State/InMemoryState.js";
import { CloudflareEnvironment } from "../../../node_modules/alchemy/lib/Cloudflare/CloudflareEnvironment.js";
import { Stack, evalStack } from "alchemy/Stack";
import { poolObservationStore } from "../../../src/pool/fleet-observation.ts";
import { withReleaseRuntime } from "../runtime.ts";
import { planObservationStore } from "../observation-store-plan.ts";
import { planJournalRestore } from "../journal-restore.ts";
import {
  runDeclaredProvisioning,
  provisioningOperationDigest,
  inspectDeclaredProvisioning,
} from "../provisioning-operation.ts";
import { readRuntimeProvisioningHeader } from "../provisioning-header.ts";
import { assertB102CompletedHead, decodeB102ProvisioningRecord } from "../b102-journal-reader.ts";
import { observeJournalHeader } from "../journal-observation.ts";
import { canonical, digest } from "../manifest.ts";
import { sealRecovery } from "../recovery-envelope.ts";
const accountId = "1".repeat(32),
  candidate = "a".repeat(40),
  key = "b".repeat(64);
const writer = { accountId, candidate, lease: "synthetic-production-writer" };
globalThis.fetch = () => {
  throw new Error("REAL NETWORK DENIED");
};
const envelope = {
  format: "pool-observation-store-network-envelope-v1",
  authPreviewRequests: { createSubdomainEdgePreviewSession: 0, createScriptEdgePreview: 0 },
  authPreviewPosts: 0,
  otherCloudflareMutations: 0,
  blockedMutations: 0,
};
const source = {
  runId: 123,
  attempt: 1,
  artifactId: 456,
  archiveDigest: "c".repeat(64),
  receiptDigest: "d".repeat(64),
};
async function scenario(mode) {
  const previousRecord = {
    schemaVersion: 2,
    candidate: "e".repeat(40),
    manifest: "f".repeat(64),
    resource: "PoolProviderObservationToken",
    complete: true,
    receipt: "0".repeat(64),
    operations: { settled: { request: "1".repeat(64), outcome: "acknowledged" } },
  };
  const previous =
    mode === "v2"
      ? {
          schemaVersion: 2,
          kind: "runtime-provisioning",
          candidate: previousRecord.candidate,
          manifest: previousRecord.manifest,
          complete: true,
          sealed: sealRecovery(
            previousRecord,
            key,
            previousRecord.candidate,
            previousRecord.manifest,
            "worker-modules",
          ),
        }
      : {
          schemaVersion: 1,
          candidate: "e".repeat(40),
          manifest: "f".repeat(64),
          complete: true,
          sealed: { synthetic: "retained-private-history" },
        };
  const outputs = {
    basalt: { production: { deployed: "preserved" } },
    "basalt-release-barrier": { production: previous },
  };
  const rows = { basalt: { production: {} } };
  const memory = await Effect.runPromise(InMemoryService(rows, outputs));
  let nativeWrites = 0,
    outputWrites = 0,
    armed = false;
  const tracked = {
    ...memory,
    set: (input) => {
      nativeWrites++;
      return memory.set(input);
    },
    setOutput: (input) => {
      outputWrites++;
      if (armed && mode === "lost" && input.stack === "basalt-release-barrier")
        return memory
          .setOutput(input)
          .pipe(Effect.andThen(Effect.die(new Error("synthetic lost acknowledgement"))));
      return memory.setOutput(input);
    },
  };
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      assert.equal(request.method, "GET", "provider mutation escaped");
      assert.equal(url.pathname, `/client/v4/accounts/${accountId}/secrets_store/stores`);
      return HttpResponse.fromWeb(
        request,
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [
            {
              id: "synthetic-store",
              name: "default_secrets_store",
              account_id: accountId,
              created: "2026-01-01T00:00:00Z",
              modified: "2026-01-01T00:00:00Z",
            },
          ],
          result_info: { page: 1, per_page: 50, count: 1, total_count: 1, total_pages: 1 },
        }),
      );
    }),
  );
  const stack = Stack(
    "basalt",
    { providers: StoreProviderLive(), state: Layer.succeed(State, Effect.succeed(tracked)) },
    Effect.gen(function* () {
      yield* poolObservationStore();
      return undefined;
    }),
  );
  const program = evalStack(
    stack,
    (compiled) =>
      Effect.gen(function* () {
        const adoption = yield* planObservationStore(
          compiled,
          {
            kind: "observation-store",
            operationId: "synthetic-adoption",
            coordinatorGo: "read",
            expiresAt: 1000,
          },
          writer,
          () => 100,
        );
        const operation = { kind: "observation-store", manifest: adoption };
        const go = {
          coordinatorGo: "apply",
          manifest: provisioningOperationDigest(operation),
          expiresAt: 1000,
        };
        const receipt = yield* runDeclaredProvisioning(
          compiled,
          { operation, go },
          writer,
          key,
          "",
          { now: () => 100 },
        );
        const bytes = {
          disposition: "apply",
          manifest: go.manifest,
          receipt,
          networkEnvelope: envelope,
        };
        const proof = {
          source: { ...source, receiptDigest: digest(JSON.stringify(bytes)) },
          adoption,
          receipt,
        };
        const originalHead = structuredClone(outputs["basalt-release-barrier"].production);
        const nativeBefore = structuredClone(rows.basalt.production.PoolObservationSecrets);
        const record = readRuntimeProvisioningHeader(originalHead, key).record;
        assert.throws(
          () => decodeB102ProvisioningRecord(record),
          /runtime-private-input-invalid/,
          "b102 must reproduce the original red refusal",
        );
        assert.equal(
          observeJournalHeader(originalHead).schemaVersion,
          2,
          "main must accept the adopted v2 head",
        );
        nativeWrites = 0;
        outputWrites = 0;
        if (mode === "current-incomplete")
          outputs["basalt-release-barrier"].production.complete = false;
        if (mode === "incomplete")
          outputs["basalt-release-barrier"].production.previous = { ...previous, complete: false };
        if (mode === "unreadable")
          outputs["basalt-release-barrier"].production.previous = originalHead;
        if (mode === "unknown")
          outputs["basalt-release-barrier"].production.previous = {
            ...previous,
            schemaVersion: 99,
          };
        if (mode === "native")
          rows.basalt.production.PoolObservationSecrets.attr.storeName = "changed";
        const request = {
          kind: "observation-store-restore",
          operationId: "synthetic-restore",
          coordinatorGo: "plan",
          expiresAt: 1000,
          source: proof.source,
          adoption,
        };
        if (
          ["incomplete", "unreadable", "unknown", "native", "current-incomplete"].includes(mode)
        ) {
          const result = yield* Effect.exit(
            planJournalRestore(compiled, request, writer, proof, key, () => 100),
          );
          assert.equal(result._tag, "Failure");
          assert.equal(nativeWrites, 0);
          assert.equal(outputWrites, 0);
          return;
        }
        const manifest = yield* planJournalRestore(
          compiled,
          request,
          writer,
          proof,
          key,
          () => 100,
        );
        assert.equal(nativeWrites, 0);
        assert.equal(outputWrites, 0);
        const restore = { kind: "observation-store-restore", manifest };
        const packet = {
          operation: restore,
          go: {
            coordinatorGo: "restore",
            manifest: provisioningOperationDigest(restore),
            expiresAt: mode === "expired" ? 100 : 1000,
          },
        };
        if (mode === "drift")
          outputs["basalt-release-barrier"].production.previous = {
            ...previous,
            manifest: "0".repeat(64),
          };
        if (mode === "archive")
          outputs[`basalt-provisioning-archive-${manifest.currentHeadDigest}`] = {
            production: { status: "prepared" },
          };
        armed = true;
        const apply = runDeclaredProvisioning(compiled, packet, writer, key, "", {
          now: () => 100,
          adoptionProof: proof,
        });
        const applied = yield* Effect.exit(apply);
        if (["expired", "drift", "lost", "archive"].includes(mode)) {
          assert.equal(applied._tag, "Failure");
          assert.equal(nativeWrites, 0);
          const before = outputWrites;
          const retry = yield* Effect.exit(apply);
          assert.equal(retry._tag, "Failure");
          assert.equal(outputWrites, before, "uncertain restore was repeated");
          yield* inspectDeclaredProvisioning(compiled, packet, writer, key);
          return;
        }
        if (applied._tag === "Failure") throw Cause.squash(applied.cause);
        assert.equal(applied.value.decoderCommit, "5f27c105862180cf2d6b34abdf870ded0aafd672");
        assert.equal(nativeWrites, 0);
        assert.equal(outputWrites, 3);
        assert.deepEqual(outputs["basalt-release-barrier"].production, previous);
        assertB102CompletedHead(outputs["basalt-release-barrier"].production, key);
        assert.equal(
          observeJournalHeader(outputs["basalt-release-barrier"].production).schemaVersion,
          previous.schemaVersion,
        );
        assert.deepEqual(rows.basalt.production.PoolObservationSecrets, nativeBefore);
        assert.deepEqual(outputs.basalt.production, { deployed: "preserved" });
        const archive = Object.entries(outputs).find(([name]) =>
          name.startsWith("basalt-provisioning-archive-"),
        )[1].production;
        assert.deepEqual(archive.head, originalHead, "completed adoption receipt/history changed");
        assert.equal(archive.status, "complete");
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
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
  );
  await Effect.runPromise(
    program.pipe(
      withReleaseRuntime,
      Effect.provideService(HttpClient.HttpClient, client),
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
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              ALCHEMY_STAGE: "production",
              CLOUDFLARE_ACCOUNT_ID: accountId,
              CLOUDFLARE_API_TOKEN: "synthetic-only",
            },
          }),
        ),
      ),
    ),
  );
}
for (const mode of [
  "success",
  "v2",
  "current-incomplete",
  "archive",
  "incomplete",
  "unreadable",
  "unknown",
  "native",
  "expired",
  "drift",
  "lost",
])
  await scenario(mode);
console.log("__JOURNAL_RESTORE_PROOF_PASS__");
