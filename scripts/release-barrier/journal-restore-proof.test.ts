import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digest, canonical } from "./manifest.ts";
import { observationStoreDigest } from "./observation-store-contract.ts";
import { loadAdoptionProof, verifyAdoptionReceipt } from "./journal-restore-proof.ts";

const adoption = {
  format: "pool-observation-store-adoption-v1" as const,
  candidate: "a".repeat(40),
  stack: "basalt" as const,
  stage: "production" as const,
  operationId: "synthetic-adoption",
  accountId: "1".repeat(32),
  storeId: "synthetic-store",
  storeName: "default_secrets_store",
  absentRowDigest: "b".repeat(64),
  sdkSourceDigest: "c".repeat(64),
  declarationDigest: "d".repeat(64),
};
const settled = {
  format: "pool-observation-store-adoption-receipt-v1",
  manifest: observationStoreDigest(adoption),
  nativeAfterDigest: "e".repeat(64),
  action: "noop",
  barrier: "PASS",
  barrierScope: "PoolObservationSecrets",
};
const envelope = {
  format: "pool-observation-store-network-envelope-v1",
  authPreviewRequests: { createSubdomainEdgePreviewSession: 2, createScriptEdgePreview: 2 },
  authPreviewPosts: 2,
  otherCloudflareMutations: 0,
  blockedMutations: 0,
};
const text = JSON.stringify({
  disposition: "apply",
  manifest: digest(canonical({ kind: "observation-store", manifest: adoption })),
  receipt: settled,
  networkEnvelope: envelope,
});
const bytes = Buffer.from(text);
const baseSource = {
  runId: 123,
  attempt: 1,
  artifactId: 456,
  archiveDigest: "f".repeat(64),
  receiptDigest: digest(bytes),
};

test("a restore artifact proves the exact successful workflow, candidate, archive and receipt without forwarding its repository credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "journal-restore-artifact-"));
  try {
    const names = ["network-envelope.json", "network-requests.jsonl", "receipt.json"];
    for (const name of names)
      await writeFile(join(directory, name), name === "receipt.json" ? text : "synthetic-only");
    execFileSync("zip", ["-q", join(directory, "archive.zip"), ...names], { cwd: directory });
    const archive = await readFile(join(directory, "archive.zip"));
    const source = { ...baseSource, archiveDigest: digest(archive) };
    const requests: { url: string; authorization: string | null }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, authorization: request.headers.get("authorization") });
      if (request.url.endsWith("/attempts/1"))
        return Response.json({
          id: 123,
          run_attempt: 1,
          head_sha: adoption.candidate,
          conclusion: "success",
          path: ".github/workflows/pool-runtime-provision.yml",
        });
      if (request.url.endsWith("/artifacts/456"))
        return Response.json({
          id: 456,
          name: "pool-provisioning-123",
          digest: `sha256:${source.archiveDigest}`,
          expired: false,
          workflow_run: { id: 123, head_sha: adoption.candidate },
        });
      if (request.url.endsWith("/zip"))
        return new Response(null, {
          status: 302,
          headers: { location: "https://archive.example.test/signed" },
        });
      if (request.url === "https://archive.example.test/signed") return new Response(archive);
      throw new Error("Unexpected artifact request");
    };
    const proof = await loadAdoptionProof(
      source,
      adoption,
      { GITHUB_REPOSITORY: "synthetic/basalt", GITHUB_TOKEN: "synthetic-only" },
      fetcher,
    );
    assert.deepEqual(proof.receipt, settled);
    assert.equal(requests.length, 4);
    assert.equal(requests.at(-1)!.authorization, null);
    await assert.rejects(
      loadAdoptionProof(
        { ...source, runId: 999 },
        adoption,
        { GITHUB_REPOSITORY: "synthetic/basalt", GITHUB_TOKEN: "synthetic-only" },
        fetcher,
      ),
    );
    await assert.rejects(
      loadAdoptionProof(
        { ...source, archiveDigest: "0".repeat(64) },
        adoption,
        { GITHUB_REPOSITORY: "synthetic/basalt", GITHUB_TOKEN: "synthetic-only" },
        fetcher,
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a mismatched source receipt, operation or network envelope refuses before restore planning", () => {
  const proof = { source: baseSource, adoption };
  assert.deepEqual(verifyAdoptionReceipt(bytes, proof).receipt, settled);
  assert.throws(() =>
    verifyAdoptionReceipt(bytes, {
      ...proof,
      source: { ...baseSource, receiptDigest: "0".repeat(64) },
    }),
  );
  assert.throws(() =>
    verifyAdoptionReceipt(bytes, { ...proof, adoption: { ...adoption, storeId: "changed" } }),
  );
  const bad = Buffer.from(
    JSON.stringify({
      ...JSON.parse(text),
      networkEnvelope: { ...envelope, otherCloudflareMutations: 1 },
    }),
  );
  assert.throws(() =>
    verifyAdoptionReceipt(bad, { ...proof, source: { ...baseSource, receiptDigest: digest(bad) } }),
  );
});
