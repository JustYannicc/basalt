import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { runtimeProofFixture } from "../../scripts/release-barrier/test/runtime-proof-fixture.ts";

// The default remains native workerd fetch; only the outbound service is synthetic.
test("the default provider fetcher observes through native workerd and refuses redirects and unavailable replies", async () => {
  const fixture = await runtimeProofFixture();
  const bundle = await build({
    stdin: {
      contents: `import { RuntimeProviderReader } from "./src/pool/runtime-provider/read.ts";
        export default { async fetch(request, env) {
          if (new URL(request.url).pathname === "/direct")
            return fetch("https://api.cloudflare.com/synthetic-control");
          const reader = new RuntimeProviderReader("synthetic-provider-token");
          try {
            return Response.json(await reader.observe(env.expected));
          } catch (error) {
            return Response.json({ error: error.message, code: error.code ?? null }, { status: 409 });
          }
        } };`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "ts",
      sourcefile: "runtime-provider-workerd-proof.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    external: ["node:*", "cloudflare:workers"],
  });
  let providerCalls = 0;
  let unavailable = false;
  let redirect = false;
  const marker = "private-provider-body-or-credential";
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  const worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        expected: {
          ...fixture.manifest.provider,
          applicationId: fixture.raw.id,
          applicationVersion: "1",
          imageDigest: fixture.manifest.target.imageDigest,
        },
      },
      outboundService: async (request: Request) => {
        assert.equal(new URL(request.url).origin, "https://api.cloudflare.com");
        providerCalls++;
        if (unavailable) return new Response(marker, { status: 503 });
        if (redirect)
          return new Response(null, {
            status: 302,
            headers: { Location: "https://other.invalid/private" },
          });
        return Response.json({ success: true, errors: [], result: fixture.raw });
      },
    }),
  );
  try {
    await worker.ready;
    assert.equal((await worker.dispatchFetch("http://localhost/direct")).status, 200);
    assert.equal(providerCalls, 1);
    const observed = await worker.dispatchFetch("http://localhost/observe");
    assert.equal(observed.status, 200, await observed.clone().text());
    assert.equal(providerCalls, 2);
    assert.equal((await observed.json()).applicationId, fixture.raw.id);
    redirect = true;
    const beforeRedirect = providerCalls;
    const redirected = await worker.dispatchFetch("http://localhost/observe");
    assert.equal(redirected.status, 409);
    assert.equal(providerCalls, beforeRedirect + 1);
    redirect = false;
    unavailable = true;
    const refused = await worker.dispatchFetch("http://localhost/observe");
    assert.equal(refused.status, 409);
    const body = await refused.text();
    assert.equal(body.includes(marker), false);
    assert.deepEqual(JSON.parse(body), {
      error: "Pool provider observation refused",
      code: "provider_observation_refused",
    });
  } finally {
    await worker.dispose();
  }
});
