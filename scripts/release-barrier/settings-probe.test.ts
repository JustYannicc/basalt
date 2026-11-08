import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { probeWorkerSettings } from "./settings-probe.ts";
import { baselineRoles } from "./baseline-probe.ts";
import { normalizePlacement } from "./script-placement.ts";
import { assertScriptSettings, scriptSettingFields } from "./script-settings.ts";
import { BarrierRefusal } from "./manifest.ts";
import { placementRepairTargets } from "./pending-placement.ts";

for (const mode of ["same", "drift", "repair"] as const) {
  const drift = mode === "drift";
  const repair = mode === "repair";
  test(`full settings probe compares all 19 roles and ${mode}`, async (context) => {
    const requests: { method: string | undefined; path: string; bytes: number }[] = [];
    const server = createServer(async (request, response) => {
      let bytes = 0;
      for await (const chunk of request) bytes += chunk.length;
      const path = request.url!;
      requests.push({ method: request.method, path, bytes });
      const target = repair
        ? placementRepairTargets.find((target) => path.includes(target.scriptName))
        : undefined;
      let result: unknown;
      if (path.endsWith("/scripts"))
        result = baselineRoles.map((role) => ({
          id: repair
            ? (placementRepairTargets.find((target) => target.role === role)?.scriptName ??
              `basalt-${role.toLowerCase()}-production-fixture`)
            : `basalt-${role.toLowerCase()}-production-fixture`,
        }));
      else if (path.endsWith("/deployments"))
        result = {
          deployments: [
            {
              id: target?.deployment ?? "deployment",
              created_on: "2026-11-01T00:00:00Z",
              source: "api",
              strategy: "percentage",
              versions: [{ version_id: target?.version ?? "active", percentage: 100 }],
            },
          ],
        };
      else if (path.endsWith("/settings"))
        result = {
          placement: target ? undefined : { mode: "targeted", target: [39] },
          logpush: drift && path.includes("publicsite"),
          limits: { subrequests: drift && path.includes("api-production") ? 100 : 50_000 },
          observability: { enabled: true, head_sampling_rate: 1 },
          tags: [],
          bindings: [],
          tail_consumers: [],
        };
      else if (path.includes("/versions/"))
        result = {
          id: path.split("/").at(-1),
          resources: {
            script: {
              placement:
                target && path.endsWith(target.version)
                  ? undefined
                  : {
                      mode: "targeted",
                      target: [{ id: 39, type: "region", region: "aws:eu-central-1" }],
                    },
              secret_fixture: "private-fixture",
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
    const rows = await probeWorkerSettings(
      "fixture",
      "private-fixture",
      {},
      `http://127.0.0.1:${address.port}`,
      async (workers) =>
        workers.map((worker) => ({
          ...worker,
          retiredPlacement: false,
          metadata: {
            placement: { region: "aws:eu-central-1" },
            limits: { subrequests: 50_000 },
            observability: { enabled: true },
            tags: [],
          },
        })),
    );
    assert.equal(rows.length, 19);
    assert.equal(requests.length, repair ? 60 : 58);
    assert.ok(requests.every((request) => request.method === "GET" && request.bytes === 0));
    for (const row of rows) {
      assert.equal(row.ok, !drift || !["Api", "PublicSite"].includes(row.role));
      assert.deepEqual(row.compared, scriptSettingFields);
      assert.equal(row.placements.status, 200);
      assert.equal(
        row.placements.attempts,
        repair && ["Api", "AppPages"].includes(row.role) ? 2 : 1,
      );
      assert.equal(
        Boolean(row.pendingPlacementRepair),
        repair && ["Api", "AppPages"].includes(row.role),
      );
      if (!row.ok)
        assert.ok(
          row.differences.some(
            (change) => change.path === (row.role === "Api" ? "limits.subrequests" : "logpush"),
          ),
        );
    }
    assert.doesNotMatch(
      JSON.stringify(rows.map(({ pendingPlacementRepair: _repair, ...row }) => row)),
      /private-fixture|resources|secret_fixture|scriptName/,
    );
  });
}

test("numeric placement refuses absent, foreign and conflicting active-version proofs", () => {
  const numeric = { mode: "targeted", target: [39] };
  const proof = {
    id: "active",
    placement: {
      mode: "targeted",
      target: [{ id: 39, region: "aws:eu-central-1", type: "region" }],
    },
  };
  assert.throws(() => normalizePlacement(numeric), /unresolved-script-placement/);
  assert.throws(
    () => normalizePlacement(numeric, [proof], [{ versionId: "latest" }]),
    /unresolved-script-placement/,
  );
  assert.throws(
    () =>
      normalizePlacement(
        numeric,
        [
          {
            ...proof,
            placement: { mode: "targeted", target: [{ id: 40, region: "aws:eu-central-1" }] },
          },
        ],
        [{ versionId: "active" }],
      ),
    /unresolved-script-placement/,
  );
  assert.throws(
    () =>
      normalizePlacement(
        numeric,
        [
          proof,
          {
            id: "second",
            placement: {
              mode: "targeted",
              target: [{ id: 39, region: "aws:us-east-1", type: "region" }],
            },
          },
        ],
        [{ versionId: "active" }, { versionId: "second" }],
      ),
    /conflicting-script-placement/,
  );
});

test("refusals name every changed script field without exposing private values", () => {
  assert.throws(
    () =>
      assertScriptSettings(
        "Api",
        "worker",
        {
          limits: { subrequests: 50_000 },
          logpush: true,
          observability: { enabled: true },
          tags: ["private-token"],
          placement: { region: "aws:eu-central-1" },
        },
        {
          limits: { subrequests: 100 },
          logpush: false,
          observability: { enabled: false },
          tags: [],
          placement: { region: "aws:us-east-1" },
        },
      ),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      const changes = error.delta!.changed;
      for (const path of [
        "limits.subrequests",
        "logpush",
        "observability.enabled",
        "placement.target.0.region",
        "tags.0",
      ])
        assert.ok(
          changes.some((change) => change.path === path),
          path,
        );
      assert.doesNotMatch(JSON.stringify(changes), /private-token/);
      return true;
    },
  );
});

test("declaration metadata reads cannot broaden the probe's account, method or query boundary", async (context) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        success: true,
        result: baselineRoles.map((role) => ({
          id: `basalt-${role.toLowerCase()}-production-fixture`,
        })),
        errors: [],
        messages: [],
      }),
    );
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
  const base = `http://127.0.0.1:${address.port}`;
  const path = "/accounts/fixture/workers/durable_objects/namespaces";
  await assert.rejects(
    probeWorkerSettings("fixture", "fixture-token", {}, base, async () => {
      for (const [suffix, method] of [
        [`${path}?page=1`, "POST"],
        [path.replace("fixture", "other") + "?page=1", "GET"],
        [`${path}?page=1&class=private`, "GET"],
        [`${path}/objects?page=1`, "GET"],
      ]) {
        await assert.rejects(fetch(base + suffix, { method }), /outside its read-only inventory/);
      }
      throw new Error("boundary-verified");
    }),
    /boundary-verified/,
  );
  assert.equal(requests, 1);
});
