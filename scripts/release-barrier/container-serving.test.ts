import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";
import { verifyServingContainer } from "./container-serving.ts";
import { containerPublication } from "./test/container-fixture.ts";
import { handleDeploymentReadiness } from "../../src/pool/deployment-readiness.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";

for (const failure of ["none", "runtime", "model-auth"] as const)
  test(`serving verification binds the actual image, private boot and unsigned probes: ${failure}`, async () => {
    const proof = containerPublication();
    const candidate = "a".repeat(40);
    const key = "b".repeat(64);
    const instanceId = "c".repeat(64);
    const paths: string[] = [];
    const target = {
      candidate,
      workerInput: poolWorkerRevision,
      imageHash: proof.frozen.inputHash,
    };
    const originalFetch = globalThis.fetch;
    const operations = async (request: Request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/deployment-readiness")
        return handleDeploymentReadiness(request, target, key, async () => {
          if (failure === "runtime") throw new Error("Home/node/policy not ready");
          return { ...target, desiredRevisionMatch: true, instanceId, bootId: "boot", readyAt: 1 };
        });
      assert.equal(path, "/runtime-recovery");
      return Response.json({
        instanceId,
        imageHash: target.imageHash,
        running: true,
        ready: true,
        bootId: "boot",
      });
    };
    // Instance verification uses its injected fetcher. This guard catches accidental unbound requests.
    globalThis.fetch = async () => {
      throw new Error("No external requests in serving proof");
    };
    try {
      const effect = verifyServingContainer(
        proof.frozen,
        {
          worker: "PoolWorker",
          accountId: "fixture",
          connect: async () => ({
            env: { POOL_OPERATIONS: { fetch: operations } },
            dispose: async () => {},
          }),
        },
        candidate,
        async (input, init) => {
          const path = new URL(String(input)).pathname;
          paths.push(path);
          assert.equal(init?.method ?? "GET", "GET");
          if (path === "/pool/v1/pool") return new Response(null, { status: 401 });
          if (path === "/health") return new Response(null, { status: 200 });
          if (path === "/v1/models")
            return new Response(null, { status: failure === "model-auth" ? 200 : 401 });
          const result = path.endsWith("/instances-v2")
            ? [
                {
                  id: "instance",
                  application_id: "pool-app",
                  image: proof.proposed.configuration.image,
                  status: { state: "running" },
                },
              ]
            : {
                id: "pool-app",
                account_id: "fixture",
                configuration: proof.proposed.configuration,
              };
          return Response.json({ success: true, errors: [], result, result_info: {} });
        },
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                CLOUDFLARE_API_TOKEN: "synthetic-never-sent",
                POOL_DEPLOYMENT_KEY: key,
              },
            }),
          ),
        ),
      );
      if (failure !== "none")
        await assert.rejects(Effect.runPromise(effect), /container-serving-not-verified/);
      else {
        const serving = await Effect.runPromise(effect);
        assert.equal(serving.bootId, "boot");
        assert.equal(serving.digest, proof.frozen.imageDigest);
        assert.ok(
          paths.includes("/health") &&
            paths.includes("/v1/models") &&
            paths.some((path) => path.endsWith("/instances-v2")),
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
