import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { accountMirrorPrefix } from "../../src/pool/account-key-mirror.ts";
import { signEnvelope } from "../../src/pool/token.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");

test("real Worker mirror ingress caps delivered bytes and still accepts a signed account", { timeout: 20_000 }, async () => {
  const bundle = await build({
    stdin: {
      contents: `import { handleAccountKeyMirror } from "./src/pool/account-key-mirror.ts";
        import { HomeClient } from "./src/pool/control.ts";
        const overflowProof = Promise.withResolvers();
        export default { async fetch(request) {
          if (request.method === "GET" && new URL(request.url).pathname === "/proof/overflow")
            return Response.json(await overflowProof.promise);
          let delivered = 0, cancelled = false, calls = 0;
          const getReader = request.body.getReader.bind(request.body);
          request.body.getReader = (options) => {
            const reader = getReader(options);
            return {
              async read(view) { const result = await reader.read(view); delivered += result.value?.byteLength ?? 0; return result; },
              cancel() { cancelled = true; return reader.cancel(); },
              releaseLock() { reader.releaseLock(); },
            };
          };
          const home = new HomeClient(async (_path, init) => {
            calls++;
            return Response.json({ name: JSON.parse(init.body).uuid + ".json" });
          });
          const response = await handleAccountKeyMirror(request, { home, signingKey: "ab".repeat(32) });
          const proof = { status: response.status, delivered, cancelled, calls };
          if (response.status === 413) overflowProof.resolve(proof);
          return Response.json(proof, { status: response.status });
        } };`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts", sourcefile: "mirror-ingress-proof.ts",
    }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2023",
  });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"] });
  try {
    const overflow = await mf.dispatchFetch("https://fixture/pool/v1/account-mirrors", {
      method: "POST", body: new Uint8Array(4 * 1024 * 1024),
    }).catch((error: unknown) => {
      assert.ok(error instanceof TypeError && error.cause instanceof Error
        && "code" in error.cause && error.cause.code === "ECONNRESET"
        && "syscall" in error.cause && error.cause.syscall === "write",
      "Only a connection reset while writing the oversized upload is an accepted refusal");
      return undefined;
    });
    if (overflow) {
      assert.equal(overflow.status, 413);
      await overflow.body?.cancel();
    }
    // The readback awaits the Worker's actual refusal even if the upload lost its response.
    const observed = await mf.dispatchFetch("https://fixture/proof/overflow");
    assert.deepEqual(await observed.json(), { status: 413, delivered: 65_537, cancelled: true, calls: 0 });
    const at = Date.now();
    const body = JSON.stringify({ envelope: await signEnvelope("ab".repeat(32), accountMirrorPrefix, {
      action: "upsert", reference: "12345678-abcd-4000-8000-000000000001", at, expiresAt: at + 30_000,
      credential: { type: "typesafe", token: "synthetic-key" },
    }) });
    const saved = await mf.dispatchFetch("https://fixture/pool/v1/account-mirrors", { method: "POST", body });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), { status: 200, delivered: Buffer.byteLength(body), cancelled: false, calls: 1 });
  } finally { await mf.dispose(); }
});
