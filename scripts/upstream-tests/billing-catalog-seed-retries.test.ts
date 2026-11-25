import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { billingCatalogDeclaration } from "../../.upstream/apps/hosted/cloud/src/contracts/billing-catalog.ts";
import { seedBillingCatalog } from "../../.upstream/apps/hosted/cloud/src/infrastructure/billing-catalog-seed.ts";

/** An emulator seed endpoint that leaves its first `hung` requests unanswered. */
const seedEndpoint = (hung: number) =>
  new Promise<{ origin: string; bodies: string[]; close: () => void }>((resolve) => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        bodies.push(body);
        if (request.url !== "/_emulate/seed") return void response.writeHead(404).end();
        if (bodies.length <= hung) return;
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        bodies,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      }),
    );
  });

test("a hung billing catalog seed is abandoned and sent again within its budget", async () => {
  const endpoint = await seedEndpoint(1);
  try {
    const started = Date.now();
    await Effect.runPromise(
      seedBillingCatalog(
        Redacted.make(endpoint.origin),
        Redacted.make("synthetic-seed-key"),
        billingCatalogDeclaration("ci", "sandbox"),
      ),
    );
    // A seed without an attempt bound waits out the whole 30 s budget on the first request.
    assert.equal(endpoint.bodies.length, 2);
    assert.ok(Date.now() - started < 20_000);
    // The repeat is the same upsert, so it converges on the same catalog.
    assert.equal(endpoint.bodies[1], endpoint.bodies[0]);
  } finally {
    endpoint.close();
  }
});
