import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { provisioningOperationDigest } from "./provisioning-operation.ts";

test("plan, apply and inspect refuse an absent or mismatched run pin before GitHub or State access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "restore-run-pin-"));
  try {
    const preload = join(directory, "deny-network.mjs");
    await writeFile(preload, 'globalThis.fetch = () => { throw new Error("NETWORK ESCAPED"); };');
    const adoption = {
      format: "pool-observation-store-adoption-v1" as const,
      candidate: "b".repeat(40),
      stack: "basalt" as const,
      stage: "production" as const,
      operationId: "synthetic-adoption",
      accountId: "1".repeat(32),
      storeId: "synthetic-store",
      storeName: "default_secrets_store",
      absentRowDigest: "a".repeat(64),
      sdkSourceDigest: "b".repeat(64),
      declarationDigest: "c".repeat(64),
    };
    const source = {
      runId: 123,
      attempt: 1,
      artifactId: 456,
      archiveDigest: "d".repeat(64),
      receiptDigest: "e".repeat(64),
    };
    const operation = {
      kind: "observation-store-restore" as const,
      manifest: {
        format: "pool-observation-journal-restore-v1" as const,
        candidate: "a".repeat(40),
        stack: "basalt" as const,
        stage: "production" as const,
        accountId: adoption.accountId,
        operationId: "synthetic-restore",
        source,
        adoption,
        currentHeadDigest: "1".repeat(64),
        previousHeadDigest: "2".repeat(64),
        nativeStoreDigest: "3".repeat(64),
        decoderDigest: "4".repeat(64),
      },
    };
    const go = {
      coordinatorGo: "synthetic-GO",
      expiresAt: Date.now() + 3_600_000,
      manifest: provisioningOperationDigest(operation),
    };
    for (const mode of ["plan", "apply", "inspect"]) {
      for (const pin of [undefined, "999"]) {
        const output = join(directory, `${mode}-${pin ?? "absent"}`);
        const result = spawnSync(
          process.execPath,
          ["--import", preload, fileURLToPath(new URL("./provisioning-entry.ts", import.meta.url))],
          {
            encoding: "utf8",
            timeout: 15_000,
            env: {
              PATH: process.env.PATH,
              GITHUB_ACTIONS: "true",
              GITHUB_REF: "refs/heads/main",
              GITHUB_WORKFLOW_REF:
                "synthetic/basalt/.github/workflows/pool-runtime-provision.yml@refs/heads/main",
              GITHUB_SHA: operation.manifest.candidate,
              GITHUB_RUN_ID: "789",
              GITHUB_RUN_ATTEMPT: "1",
              CLOUDFLARE_ACCOUNT_ID: adoption.accountId,
              ALCHEMY_STAGE: "production",
              POOL_OBSERVATION_STORE_RESTORE_RUN_ID: pin,
              POOL_PROVISIONING_MODE: mode,
              POOL_PROVISIONING_OUTPUT_DIRECTORY: output,
              POOL_PROVISIONING_PACKET: JSON.stringify(
                mode === "plan"
                  ? {
                      kind: operation.kind,
                      operationId: operation.manifest.operationId,
                      coordinatorGo: go.coordinatorGo,
                      expiresAt: go.expiresAt,
                      source,
                      adoption,
                    }
                  : { operation, go },
              ),
            },
          },
        );
        assert.equal(result.status, 1, result.stderr);
        const failure = JSON.parse(await readFile(join(output, "failure.json"), "utf8"));
        assert.equal(failure.reason, "journal-restore-run-not-approved");
        assert.doesNotMatch(result.stdout + result.stderr, /NETWORK ESCAPED/u);
        const envelope = JSON.parse(await readFile(join(output, "network-envelope.json"), "utf8"));
        assert.equal(envelope.authPreviewRequests.createSubdomainEdgePreviewSession, 0);
        assert.equal(envelope.authPreviewRequests.createScriptEdgePreview, 0);
        assert.equal(envelope.otherCloudflareMutations, 0);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
