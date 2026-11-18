import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type * as Workers from "@distilled.cloud/cloudflare/workers";
import { discoverScriptSettings } from "../architecture/native-stack.ts";
import { probeWorkerSettings } from "./settings-probe.ts";
import { baselineRoles } from "./baseline-probe.ts";

const scriptName = (role: string) =>
  role === "ArtifactsCredentials"
    ? `basalt-artifactscredentials-pr${"a".repeat(24)}`
    : `basalt-${role.toLowerCase()}-production-fixture`;
const snake = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(snake)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
            snake(item),
          ]),
        )
      : value;
const declared = (
  discoverScriptSettings(process.cwd()) as { role: string; metadata: Workers.PutScriptMetadata }[]
).find((row) => row.role === "PoolWorker")!.metadata;
const bulkImport = {
  type: "durable_object_namespace" as const,
  name: "BulkUsageImport",
  className: "BulkUsageImport",
};

const cases: {
  mode: string;
  poolMetadata: Workers.PutScriptMetadata;
  /** Which of the declared classes the live settings already hold. */
  live: boolean | "blue-only";
  reason?: string;
}[] = [
  { mode: "declared fleet classes before the class step", poolMetadata: declared, live: false },
  { mode: "declared fleet classes once live", poolMetadata: declared, live: true },
  {
    mode: "an undeclared class beside the declared ones",
    poolMetadata: { ...declared, bindings: [...declared.bindings!, bulkImport] },
    live: false,
    reason: "declared-class-binding-mismatch",
  },
  {
    mode: "an undeclared class alone",
    poolMetadata: {
      ...declared,
      bindings: [declared.bindings![0]!, bulkImport],
      tags: declared.tags!.map((tag) =>
        tag.startsWith("alchemy:dos:") ? "alchemy:dos:BulkUsageImport;PoolContainer" : tag,
      ),
    },
    live: false,
    reason: "durable-object-class-drift",
  },
  {
    mode: "a changed stage tag beside the declared classes",
    poolMetadata: {
      ...declared,
      tags: declared.tags!.map((tag) =>
        tag.startsWith("alchemy:stage:") ? "alchemy:stage:preview" : tag,
      ),
    },
    live: false,
    reason: "declared-class-tags-mismatch",
  },
  {
    mode: "live settings that hold only PoolRuntimeBlue of the declared classes",
    poolMetadata: declared,
    live: "blue-only",
    reason: "declared-class-binding-mismatch",
  },
];
/** The live bindings for each case: the baseline's PoolContainer, then the live declared classes. */
const liveBindings = (live: boolean | "blue-only") =>
  live === true
    ? declared.bindings!
    : live === "blue-only"
      ? declared.bindings!.filter(
          (binding) =>
            "name" in binding && ["PoolContainer", "PoolRuntimeBlue"].includes(binding.name),
        )
      : declared.bindings!.slice(0, 1);
const liveTags = (live: boolean | "blue-only") =>
  live === true
    ? declared.tags
    : [
        "alchemy:stack:basalt",
        "alchemy:stage:production",
        "alchemy:id:PoolWorker",
        live === "blue-only"
          ? "alchemy:dos:PoolContainer;PoolRuntimeBlue"
          : "alchemy:dos:PoolContainer",
      ];

for (const { mode, poolMetadata, live, reason } of cases)
  test(`the baseline probe judges ${mode} on the production PoolWorker shape`, async (context) => {
    const server = createServer(async (request, response) => {
      for await (const _chunk of request);
      const path = request.url!;
      const pool = path.includes("poolworker");
      let result: unknown;
      if (path.endsWith("/scripts"))
        result = baselineRoles.map((role) => ({
          id: scriptName(role),
          tags: ["alchemy:stack:basalt", "alchemy:stage:production", `alchemy:id:${role}`],
        }));
      else if (path.endsWith("/deployments"))
        result = {
          deployments: [
            {
              id: "deployment",
              created_on: "2026-11-01T00:00:00Z",
              source: "api",
              strategy: "percentage",
              versions: [{ version_id: "active", percentage: 100 }],
            },
          ],
        };
      else if (path.endsWith("/settings"))
        result = pool
          ? {
              // Production: alchemy made PoolWorker untagged, with only PoolContainer as a local class.
              logpush: false,
              observability: snake(declared.observability),
              tags: liveTags(live),
              bindings: [
                { name: "POOL_IMAGE_HASH", type: "plain_text", text: "b".repeat(16) },
                ...liveBindings(live).map((binding) => ({
                  ...(snake(binding) as Record<string, unknown>),
                  namespace_id: `namespace-${"name" in binding ? binding.name : ""}`,
                })),
              ],
              tail_consumers: [],
            }
          : {
              placement: { mode: "targeted", target: [39] },
              logpush: false,
              limits: { subrequests: 50_000 },
              observability: { enabled: true, head_sampling_rate: 1 },
              tags: [],
              bindings: [{ name: "POOL_IMAGE_HASH", type: "plain_text", text: "b".repeat(16) }],
              tail_consumers: [],
            };
      else if (path.includes("/versions/"))
        result = {
          id: path.split("/").at(-1),
          resources: {
            bindings: [{ name: "POOL_IMAGE_HASH", type: "plain_text", text: "b".repeat(16) }],
            script_runtime: {},
            script: {
              placement: {
                mode: "targeted",
                target: [{ id: 39, type: "region", region: "aws:eu-central-1" }],
              },
            },
          },
        };
      else {
        response.writeHead(400);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true, result, errors: [], messages: [] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    // The probe loads the repository's real release-declarations.json.
    const rows = await probeWorkerSettings(
      "fixture",
      "private-fixture",
      {},
      `http://127.0.0.1:${address.port}`,
      async (workers) =>
        workers.map((worker) => ({
          ...worker,
          retiredPlacement: false,
          metadata:
            worker.role === "PoolWorker"
              ? poolMetadata
              : {
                  placement: { region: "aws:eu-central-1" },
                  limits: { subrequests: 50_000 },
                  observability: { enabled: true },
                  tags: [],
                },
        })),
    );
    assert.equal(rows.length, baselineRoles.length);
    for (const row of rows.filter((row) => row.role !== "PoolWorker"))
      assert.equal(row.ok, true, `${row.role}: ${row.reason}`);
    const pool = rows.find((row) => row.role === "PoolWorker")!;
    if (reason === undefined) assert.equal(pool.ok, true, `${pool.reason}`);
    else assert.deepEqual({ ok: pool.ok, reason: pool.reason }, { ok: false, reason });
  });
