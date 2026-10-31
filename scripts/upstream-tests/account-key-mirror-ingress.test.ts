import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { accountMirrorPrefix } from "../../src/pool/account-key-mirror.ts";
import { signEnvelope } from "../../src/pool/token.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");

test("real Worker mirror ingress caps delivered bytes and still accepts a signed account", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { handleAccountKeyMirror } from "./src/pool/account-key-mirror.ts";
        import { HomeClient } from "./src/pool/control.ts";
        export default { async fetch(request) {
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
          return Response.json({ status: response.status, delivered, cancelled, calls });
        } };`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts", sourcefile: "mirror-ingress-proof.ts",
    }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2023",
  });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"] });
  try {
    const overflow = await mf.dispatchFetch("https://fixture/pool/v1/account-mirrors", {
      method: "POST", body: new Uint8Array(4 * 1024 * 1024),
    });
    assert.deepEqual(await overflow.json(), { status: 413, delivered: 65_537, cancelled: true, calls: 0 });
    const at = Date.now();
    const body = JSON.stringify({ envelope: await signEnvelope("ab".repeat(32), accountMirrorPrefix, {
      action: "upsert", reference: "12345678-abcd-4000-8000-000000000001", at, expiresAt: at + 30_000,
      credential: { type: "typesafe", token: "synthetic-key" },
    }) });
    const saved = await mf.dispatchFetch("https://fixture/pool/v1/account-mirrors", { method: "POST", body });
    assert.deepEqual(await saved.json(), { status: 200, delivered: Buffer.byteLength(body), cancelled: false, calls: 1 });
  } finally { await mf.dispose(); }
});
