import assert from "node:assert/strict";
import { test } from "node:test";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Effect, Schema } from "effect";
import { deployClassExpansion } from "./class-cloudflare.ts";
import {
  productionTagPrefixes,
  productionTags,
  productionVersionKeys,
} from "./test/production-pool-worker-shape.ts";
import { productionPoolWorker } from "./test/production-pool-worker.ts";
import { productionWorker, productionWorkerResponse } from "./test/production-worker-api.ts";

type Read = (path: string) => Promise<Response | undefined>;
const origin = "https://api.cloudflare.com/client/v4";

/** The three read-backs the release owner checked in production, as each stand-in serves them. */
async function assertProductionShape(read: Read, accountId: string, scriptName: string) {
  const base = `/accounts/${accountId}/workers`;
  const result = async (path: string) => {
    const response = await read(path);
    assert.ok(response, `no stand-in route for ${path}`);
    return ((await response.json()) as { result: Record<string, unknown> }).result;
  };
  const deployments = (await result(`${base}/scripts/${scriptName}/deployments`)) as {
    deployments: { versions: { version_id: string }[] }[];
  };
  const active = deployments.deployments[0]!.versions[0]!.version_id;
  const version = await result(`${base}/workers/${scriptName}/versions/${active}`);
  assert.deepEqual(Object.keys(version), [...productionVersionKeys]);
  const settings = (await result(`${base}/scripts/${scriptName}/settings`)) as { tags: string[] };
  assert.deepEqual(
    settings.tags.map((tag) => productionTagPrefixes.find((prefix) => tag.startsWith(prefix))),
    [...productionTagPrefixes],
  );
  const script = (await result(`${base}/scripts/${scriptName}/versions/${active}`)) as {
    resources: { script_runtime: Record<string, unknown> };
  };
  assert.ok(script.resources.script_runtime);
  assert.equal("migration_tag" in script.resources.script_runtime, false);
}

test("the GET-only stand-in serves PoolWorker's version, settings and runtime as production reads", async () => {
  const worker = productionWorker();
  await assertProductionShape(
    async (path) => productionWorkerResponse(worker, "GET", new URL(`${origin}${path}`)),
    worker.accountId,
    worker.scriptName,
  );
});

test("the stateful stand-in keeps production's shape before and after the class PUT and a code upload", async () => {
  const target = { accountId: "0".repeat(32), scriptName: "PoolWorker" };
  const worker = productionPoolWorker(target);
  const read: Read = (path) => worker.fetcher(`${origin}${path}`);
  await assertProductionShape(read, target.accountId, target.scriptName);
  const metadata = Schema.decodeUnknownSync(Schema.toType(Workers.PutScriptMetadata))({
    mainModule: "worker.js",
    bindings: [
      { type: "inherit", name: "PoolContainer" },
      { type: "inherit", name: "POOL_PRESERVE_LEGACY_IMAGE" },
      { type: "durable_object_namespace", name: "PoolRuntimeBlue", className: "PoolRuntimeBlue" },
    ],
    migrations: { newSqliteClasses: ["PoolRuntimeBlue"] },
    containers: [{ className: "PoolContainer" }],
    tags: productionTags(["PoolContainer", "PoolRuntimeBlue"]),
    annotations: { workersMessage: "synthetic-marker" },
  });
  await Effect.runPromise(
    deployClassExpansion({
      ...target,
      bindingsInherit: "strict",
      metadata,
      files: [
        new File(["export default {};\n"], "worker.js", { type: "application/javascript+module" }),
      ],
    }).pipe(Effect.provide(worker.layer)),
  );
  assert.deepEqual(worker.log.refusals, []);
  assert.ok(worker.classes().PoolRuntimeBlue);
  await assertProductionShape(read, target.accountId, target.scriptName);
  worker.deployCode(["PoolContainer", "PoolRuntimeBlue"]);
  await assertProductionShape(read, target.accountId, target.scriptName);
});
