import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { baselineProbeTable, baselineRoles, probeBaselines } from "./baseline-probe.ts";

test("native probe refuses redirected inventory without reading its destination", async (context) => {
  let contentReads = 0;
  const server = createServer((request, response) => {
    if (request.url === "/accounts/fixture/workers/scripts") {
      response.writeHead(302, { location: "/content" });
      response.end();
    } else {
      contentReads++;
      response.setHeader("content-type", "application/json");
      response.end("{}");
    }
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
  await assert.rejects(
    probeBaselines("fixture", "private-fixture", `http://127.0.0.1:${address.port}`),
  );
  assert.equal(contentReads, 0);
});

test(
  "native probe reads all 20 baselines concurrently and retains only safe per-Worker metrics",
  { timeout: 5_000 },
  async (context) => {
    const requests: { method: string | undefined; bytes: number }[] = [];
    const allArrived = Promise.withResolvers<void>();
    let baselines = 0;
    const success = JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: {
        deployments: [
          {
            id: "deployment",
            created_on: "2026-11-01T00:00:00Z",
            source: "api",
            strategy: "percentage",
            author_email: "private-fixture@example.invalid",
            annotations: { "workers/message": "private-fixture" },
            versions: [{ version_id: "active", percentage: 100 }],
          },
        ],
      },
    });
    const forbidden = JSON.stringify({
      success: false,
      errors: [{ code: 10000, message: "private-fixture" }],
      messages: [],
      result: null,
    });
    const server = createServer(async (request, response) => {
      let bytes = 0;
      for await (const chunk of request) bytes += chunk.length;
      requests.push({ method: request.method, bytes });
      response.setHeader("content-type", "application/json");
      if (request.url === "/accounts/fixture/workers/scripts") {
        response.end(
          JSON.stringify({
            success: true,
            errors: [],
            messages: [],
            result: baselineRoles.map((role) => ({
              id: `basalt-${role.toLowerCase()}-production-fixture`,
              tags: ["alchemy:stack:basalt", "alchemy:stage:production", `alchemy:id:${role}`],
            })),
          }),
        );
        return;
      }
      assert.match(
        request.url ?? "",
        /^\/accounts\/fixture\/workers\/scripts\/basalt-[a-z]+-production-fixture\/deployments$/,
      );
      if (++baselines === baselineRoles.length) allArrived.resolve();
      await allArrived.promise;
      const failed = request.url!.includes("publicsite");
      response.statusCode = failed ? 403 : 200;
      response.end(failed ? forbidden : success);
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
    const rows = await probeBaselines(
      "fixture",
      "private-fixture",
      `http://127.0.0.1:${address.port}`,
    );
    assert.equal(baselines, baselineRoles.length);
    assert.deepEqual(
      requests,
      Array.from({ length: baselineRoles.length + 1 }, () => ({ method: "GET", bytes: 0 })),
    );
    assert.equal(rows.length, baselineRoles.length);
    for (const row of rows) {
      const failed = row.role === "PublicSite";
      assert.equal(row.ok, !failed);
      assert.equal(row.status, failed ? 403 : 200);
      assert.equal(row.attempts, 1);
      assert.equal(row.bytes, Buffer.byteLength(failed ? forbidden : success));
      assert.ok(row.ms >= 0);
      if (failed) assert.equal(row.type, "Unauthorized");
      assert.deepEqual(
        Object.keys(row).sort(),
        ["role", "ok", "status", "bytes", "ms", "attempts", ...(failed ? ["type"] : [])].sort(),
      );
    }
    assert.doesNotMatch(
      JSON.stringify(rows) + baselineProbeTable(rows),
      /private-fixture|basalt-|127\.0\.0\.1|version_id/,
    );
  },
);
