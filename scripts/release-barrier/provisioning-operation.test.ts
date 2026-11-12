import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import type { CompiledStack } from "alchemy/Stack";
import { provisioningWorkflowWriter } from "./provisioning-entry.ts";
import {
  provisioningOperationDigest,
  validateProvisioningOperation,
  inspectDeclaredProvisioning,
  decodeProvisioningPacket,
  type ProvisioningOperation,
} from "./provisioning-operation.ts";
import { stateProvisioningStore } from "./provisioning-state.ts";
import { provisioningJournal } from "./provisioning-journal.ts";
import { observationTokenDigest } from "./observation-token-contract.ts";
import { journalKey } from "./forward-journal.ts";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const account = "1".repeat(32),
  candidate = "a".repeat(40),
  key = "b".repeat(64);
function packet() {
  const operation: ProvisioningOperation = {
    kind: "observation-token",
    manifest: {
      format: "pool-observation-token-provisioning-v1",
      candidate,
      stack: "basalt",
      stage: "production",
      instanceId: "synthetic-native",
      accountId: account,
      sdkSourceDigest: "c".repeat(64),
      audit: { accountId: account, tokenWriteGranted: true, evidenceDigest: "d".repeat(64) },
    },
  };
  const parsed = decodeProvisioningPacket({
    operation,
    go: {
      coordinatorGo: "synthetic-reviewed",
      manifest: provisioningOperationDigest(operation),
      expiresAt: 1000,
    },
  });
  if (parsed.operation.kind !== "observation-token") throw new Error("Fixture token operation");
  return { ...parsed, operation: parsed.operation };
}
const writer = { candidate, accountId: account, lease: "deploy-production:123:1" };

test("the digest executable reads a private packet locally while provisioning refuses outside the main workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "provisioning-digest-"));
  try {
    const path = join(directory, "packet.json"),
      p = packet();
    await writeFile(path, JSON.stringify(p), { mode: 0o600 });
    const entry = new URL("./provisioning-entry.ts", import.meta.url).pathname;
    const options = {
      encoding: "utf8" as const,
      env: {
        PATH: process.env.PATH,
        GITHUB_ACTIONS: "false",
        CLOUDFLARE_API_TOKEN: "synthetic-no-log",
      },
    };
    const digest = spawnSync(process.execPath, [entry, "digest", path], options);
    assert.equal(digest.status, 0, digest.stderr);
    assert.equal(digest.stdout, `${provisioningOperationDigest(p.operation)}\n`);
    const apply = spawnSync(process.execPath, [entry], options);
    assert.equal(apply.status, 1);
    assert.match(apply.stderr, /exclusive production writer/);
    assert.equal(apply.stderr.includes("synthetic-no-log"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the production writer comes only from the exact main workflow and its current run identity", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: candidate,
    GITHUB_WORKFLOW_REF:
      "synthetic/basalt/.github/workflows/pool-runtime-provision.yml@refs/heads/main",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    CLOUDFLARE_ACCOUNT_ID: account,
    ALCHEMY_STAGE: "production",
  };
  assert.deepEqual(provisioningWorkflowWriter(env), writer);
  for (const change of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_REF: "refs/heads/other" },
    { GITHUB_WORKFLOW_REF: "synthetic/basalt/.github/workflows/deploy.yml@refs/heads/main" },
    { GITHUB_SHA: "main" },
    { GITHUB_RUN_ID: "" },
    { ALCHEMY_STAGE: "test" },
  ])
    assert.throws(
      () => provisioningWorkflowWriter({ ...env, ...change }),
      /exclusive production writer/,
    );
});

test("the GO covers the exact operation, audit and production destination and cannot outlive its deadline", () => {
  const p = packet();
  const enable = validateProvisioningOperation(p, writer, 100);
  assert.equal(enable.writerLease, writer.lease);
  assert.equal(enable.manifest, observationTokenDigest(p.operation.manifest));
  const changedManifest = (change: Partial<typeof p.operation.manifest>) => ({
    ...p,
    operation: { ...p.operation, manifest: { ...p.operation.manifest, ...change } },
  });
  for (const changed of [
    { ...p, go: { ...p.go, expiresAt: 100 } },
    { ...p, go: { ...p.go, coordinatorGo: "" } },
    changedManifest({ audit: { ...p.operation.manifest.audit, evidenceDigest: "f".repeat(64) } }),
    changedManifest({ accountId: "f".repeat(32) }),
    changedManifest({ candidate: "f".repeat(40) }),
    changedManifest({ stage: "test" }),
  ])
    assert.throws(() => validateProvisioningOperation(changed, writer, 100));
  assert.throws(() => validateProvisioningOperation(p, { ...writer, lease: "" }, 100));
});

test("expired-GO inspection retains an uncertain create and returns hashes and outcomes without native secrets or writes", async () => {
  const p = packet();
  const stack = { name: "basalt", stage: "production" } satisfies Pick<
    CompiledStack,
    "name" | "stage"
  >;
  await Effect.runPromise(
    Effect.gen(function* () {
      const memory = yield* InMemoryService();
      const store = stateProvisioningStore(memory, stack, key, (work) => work());
      const journal = provisioningJournal(
        store,
        candidate,
        observationTokenDigest(p.operation.manifest),
        "PoolProviderObservationToken",
      );
      yield* Effect.promise(() =>
        assert.rejects(
          journal.once(
            "token-create",
            "e".repeat(64),
            async () => {
              throw new Error("Lost reply");
            },
            String,
          ),
          /operation-unknown/,
        ),
      );
      yield* memory.set({
        stack: stack.name,
        stage: stack.stage,
        fqn: "PoolProviderObservationToken",
        value: {
          status: "creating",
          fqn: "PoolProviderObservationToken",
          logicalId: "PoolProviderObservationToken",
          resourceType: "Cloudflare.ApiToken.AccountApiToken",
          instanceId: "synthetic-native",
          props: { value: Redacted.make("synthetic-never-print") },
          attr: undefined,
          bindings: [],
          downstream: [],
          providerVersion: 0,
          namespace: undefined,
        },
      });
      const before = yield* memory.getOutput(journalKey(stack));
      const readonly = {
        ...memory,
        set: () => Effect.die("INSPECTION WRITE"),
        setOutput: () => Effect.die("INSPECTION WRITE"),
        delete: () => Effect.die("INSPECTION DELETE"),
      };
      const result = yield* inspectDeclaredProvisioning(
        stack,
        { ...p, go: { ...p.go, expiresAt: 1 } },
        writer,
        key,
      ).pipe(Effect.provideService(State, Effect.succeed(readonly)));
      assert.equal(result.complete, false);
      assert.equal(result.native.status, "creating");
      assert.deepEqual(
        result.operations.map(({ step, outcome }) => ({ step, outcome })),
        [{ step: "token-create", outcome: "unknown" }],
      );
      assert.equal(JSON.stringify(result).includes("synthetic-never-print"), false);
      assert.deepEqual(yield* memory.getOutput(journalKey(stack)), before);
    }),
  );
});
