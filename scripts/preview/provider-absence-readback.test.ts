import assert from "node:assert/strict";
import { test } from "node:test";

// The control plane captures fetch at import, so the fake is installed before the module loads.
const bodies = new Map<string, unknown>();
globalThis.fetch = (async (input: string | URL | Request) => {
  const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
  return Response.json(
    bodies.get(path.split("/").slice(-2).join("/")) ?? { success: false, errors: [{ code: 1 }] },
  );
}) as typeof fetch;
const { providerReadbacks } = await import("./provider-absence.ts");
const readbacks = providerReadbacks({
  CLOUDFLARE_ACCOUNT_ID: "fixture-account",
  CLOUDFLARE_API_TOKEN: "fixture-token",
  PLANETSCALE_ORGANIZATION: "fixture",
  PLANETSCALE_API_TOKEN_ID: "fixture",
  PLANETSCALE_API_TOKEN: "fixture",
});

test("a Worker domain readback that reports `errors: null` on success is authoritative", async () => {
  const domain = {
    id: "domain-1",
    hostname: "app.example.invalid",
    service: "worker-1",
    zone_id: "zone",
    zone_name: "example.invalid",
    environment: "production",
  };
  bodies.set("workers/domains", { success: true, errors: null, messages: null, result: [domain] });
  assert.deepEqual(
    (await readbacks.listWorkerDomains()).map((item) => item.hostname),
    ["app.example.invalid"],
  );
  for (const body of [
    { success: true, errors: [{ code: 10000 }], result: [] },
    { success: false, errors: null, result: [] },
  ]) {
    bodies.set("workers/domains", body);
    await assert.rejects(readbacks.listWorkerDomains(), /not authoritative/);
  }
});
