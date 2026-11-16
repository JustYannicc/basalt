import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest } from "../manifest.ts";
import { observationStoreDigest } from "../observation-store-contract.ts";

export async function restorePreparationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "restore-preparation-"));
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
  const receipt = {
    disposition: "apply",
    manifest: digest(canonical({ kind: "observation-store", manifest: adoption })),
    receipt: {
      format: "pool-observation-store-adoption-receipt-v1",
      manifest: observationStoreDigest(adoption),
      nativeAfterDigest: "e".repeat(64),
      action: "noop",
      barrier: "PASS",
      barrierScope: "PoolObservationSecrets",
    },
    networkEnvelope: {
      format: "pool-observation-store-network-envelope-v1",
      authPreviewRequests: { createSubdomainEdgePreviewSession: 1, createScriptEdgePreview: 1 },
      authPreviewPosts: 1,
      otherCloudflareMutations: 0,
      blockedMutations: 0,
    },
  };
  const bytes = Buffer.from(JSON.stringify(receipt));
  const names = ["receipt.json", "network-envelope.json", "network-requests.jsonl"];
  for (const name of names)
    await writeFile(join(directory, name), name === "receipt.json" ? bytes : "synthetic-only");
  execFileSync("zip", ["-q", join(directory, "archive.zip"), ...names], { cwd: directory });
  const archive = await readFile(join(directory, "archive.zip"));
  const source = {
    runId: 123,
    attempt: 1,
    artifactId: 456,
    archiveDigest: digest(archive),
    receiptDigest: digest(bytes),
  };
  const requests: { path: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    const path = request.url!;
    requests.push({
      path,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    });
    response.setHeader("Content-Type", "application/json");
    if (path.endsWith("/attempts/1"))
      response.end(
        JSON.stringify({
          id: source.runId,
          run_attempt: 1,
          head_sha: adoption.candidate,
          conclusion: "success",
          path: ".github/workflows/pool-runtime-provision.yml",
        }),
      );
    else if (path.endsWith("/artifacts/456"))
      response.end(
        JSON.stringify({
          id: source.artifactId,
          name: "pool-provisioning-123",
          digest: `sha256:${source.archiveDigest}`,
          expired: false,
          workflow_run: { id: source.runId, head_sha: adoption.candidate },
        }),
      );
    else if (path.endsWith("/zip")) {
      response.writeHead(302, {
        Location: "https://archive.example.test/signed?token=synthetic-signed-token",
      });
      response.end();
    } else if (path.startsWith("/signed?")) response.end(archive);
    else if (path === "/unexpected-redirect") {
      response.writeHead(302, { Location: "/escaped" });
      response.end();
    } else {
      response.writeHead(500);
      response.end("Unexpected fixture request");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  const origin = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!["api.github.com", "archive.example.test"].includes(url.hostname))
      throw new Error("REAL NETWORK DENIED");
    return nativeFetch(new Request(origin + url.pathname + url.search, request));
  };
  const env = {
    GITHUB_REPOSITORY: "synthetic/basalt",
    GITHUB_TOKEN: "synthetic-repository-token",
    POOL_OBSERVATION_STORE_RESTORE_RUN_ID: "123",
  };
  const packet = {
    kind: "observation-store-restore",
    operationId: "synthetic-restore",
    coordinatorGo: "synthetic-read-only-plan",
    expiresAt: Date.now() + 60_000,
    source,
    adoption,
  };
  return {
    directory,
    source,
    adoption,
    receipt,
    requests,
    transport,
    env,
    packet,
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}
