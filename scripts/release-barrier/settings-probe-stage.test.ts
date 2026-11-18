import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { probeWorkerSettings } from "./settings-probe.ts";
import { baselineRoles } from "./baseline-probe.ts";

// One account holds production and two rehearsal stages; each probe may read only its own stage.
const stages = [
  { stack: "basalt", stage: "production" },
  { stack: "basalt-rehearsal", stage: "test-rehearsal-1" },
  { stack: "basalt-rehearsal", stage: "test-rehearsal-2" },
];
const name = (role: string, stage: string) => `basalt-${role.toLowerCase()}-${stage}`;
// As alchemy.run.ts declares them: a rehearsal stage has no apex site and no app pages.
const roles = (stage: string): readonly string[] =>
  stage === "production" ? baselineRoles : baselineRoles.filter((role) => role !== "PublicSite" && role !== "AppPages");

async function probe(context: { after: (fn: () => Promise<void>) => void }, environment: NodeJS.ProcessEnv) {
  const requests: { method: string | undefined; path: string }[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request);
    const path = request.url!;
    requests.push({ method: request.method, path });
    let result: unknown;
    if (path === "/accounts/fixture/workers/scripts")
      result = stages.flatMap(({ stack, stage }) =>
        roles(stage).map((role) => ({
          id: name(role, stage),
          tags: [`alchemy:stack:${stack}`, `alchemy:stage:${stage}`, `alchemy:id:${role}`],
        })),
      );
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
      result = {
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
          bindings: [{ name: "POOL_IMAGE_HASH", type: "plain_text", text: "a".repeat(16) }],
          script_runtime: {},
          script: { placement: { mode: "targeted", target: [{ id: 39, type: "region", region: "aws:eu-central-1" }] } },
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
  const projected: string[] = [];
  const outcome = await probeWorkerSettings(
    "fixture",
    "private-fixture",
    environment,
    `http://127.0.0.1:${address.port}`,
    async (workers) =>
      workers.map((worker) => {
        projected.push(worker.scriptName);
        return {
          ...worker,
          retiredPlacement: false,
          metadata: {
            placement: { region: "aws:eu-central-1" },
            limits: { subrequests: 50_000 },
            observability: { enabled: true },
            tags: [],
          },
        };
      }),
  ).then(
    (rows) => ({ rows, error: undefined }),
    (error: unknown) => ({ rows: undefined, error }),
  );
  return { ...outcome, requests, projected };
}

for (const { stage, environment } of [
  { stage: "production", environment: {} },
  { stage: "production", environment: { ALCHEMY_STAGE: "production" } },
  { stage: "test-rehearsal-1", environment: { ALCHEMY_STAGE: "test-rehearsal-1" } },
])
  test(`a ${stage} probe (${environment.ALCHEMY_STAGE ?? "unset"}) reads only its own stage's Workers`, async (context) => {
    const { rows, error, requests, projected } = await probe(context, environment);
    assert.equal(error, undefined);
    assert.ok(rows);
    assert.deepEqual(rows.map((row) => row.role).sort(), [...roles(stage)].sort());
    assert.ok(rows.every((row) => row.ok), JSON.stringify(rows.filter((row) => !row.ok).map((row) => [row.role, row.reason])));
    assert.deepEqual(projected.sort(), roles(stage).map((role) => name(role, stage)).sort());
    assert.ok(requests.every((request) => request.method === "GET"));
    const reads = requests.filter((request) => !request.path.endsWith("/scripts"));
    assert.ok(reads.length >= roles(stage).length * 2);
    // Script names end in the stage, so no other stage's Worker path can match.
    for (const request of reads)
      assert.ok(
        roles(stage).some((role) => request.path.includes(`/scripts/${name(role, stage)}/`)),
        request.path,
      );
  });

test("an unknown stage refuses before anything is read", async (context) => {
  const { rows, error, requests } = await probe(context, { ALCHEMY_STAGE: "staging" });
  assert.equal(rows, undefined);
  assert.match(String((error as { reason?: unknown })?.reason ?? error), /release-stage-unknown/);
  assert.deepEqual(requests, []);
});
