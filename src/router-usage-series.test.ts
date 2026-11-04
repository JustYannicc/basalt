import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { brand } from "../brand.ts";
import { poolUsageSeriesPath, lastSuccessAtPath } from "./pool/model-history/series-http.ts";
import type { RouterEnv } from "./router.ts";

// The unrelated tunnel needs Effect; keep the real router and pool contracts under plain Node.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "../clients/contracts/tunnel.ts") return {
      url: "data:text/javascript,export const tunnelPath = '/native/v1/tunnel';",
      shortCircuit: true,
    };
    if (specifier === "./tunnel/host.ts") return {
      url: "data:text/javascript,export function handleTunnel() { throw new Error('Unexpected tunnel request'); }",
      shortCircuit: true,
    };
    return next(specifier, context);
  },
});
const { default: router } = await import("./router.ts");
hooks.deregister();

function environment(fetch: RouterEnv["POOL_SERVICE"]["fetch"]): RouterEnv {
  const unexpected = async () => { throw new Error("Usage request reached another service"); };
  return {
    TOOLS_SERVICE: { fetch: unexpected },
    CATALOG_SERVICE: { fetch: unexpected },
    POOL_SERVICE: { fetch },
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
  };
}

for (const [path, expected] of [
  [poolUsageSeriesPath, "/pool/v1/usage/series"],
  [lastSuccessAtPath, "/pool/v1/usage/last-success"],
]) {
  test(`POST ${expected} reaches POOL_SERVICE unchanged`, async () => {
    const body = JSON.stringify({ envelope: "synthetic-signed-envelope" });
    const request = new Request(`https://${brand.host}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    const reply = new Response("pool reply", { status: 202 });
    let calls = 0;
    const env = environment(async (forwarded) => {
      calls++;
      assert.strictEqual(forwarded, request);
      assert.equal(forwarded.method, "POST");
      assert.equal(forwarded.headers.get("content-type"), "application/json");
      assert.equal(await forwarded.text(), body);
      return reply;
    });
    assert.strictEqual(await router.fetch(request, env), reply);
    assert.equal(calls, 1);
    assert.equal(path, expected);
  });
}

test("legacy usage setup paths still return the public 404 page", async () => {
  const env = environment(async () => { throw new Error("Private setup request reached POOL_SERVICE"); });
  for (const path of ["/__setup/v1/poolUsageSeries", "/__setup/v1/lastSuccessAt"]) {
    const response = await router.fetch(new Request(`https://${brand.host}${path}`, { method: "POST" }), env);
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /Page not found/);
  }
});
