import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { accountAcquisitionPrefix } from "../../src/pool/account-acquisition-contract.ts";
import { signEnvelope } from "../../src/pool/token.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");

test("real Worker acquisition ingress caps delivered bytes before accepting a signed start", async () => {
  const bundle = await build({
    stdin: {
      contents: `import { HomeAccountAcquisitions } from "./src/pool/account-acquisition.ts";
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
          const home = new HomeClient(async (path) => {
            calls++;
            return Response.json(path.includes("/credentials") ? { files: [] }
              : { state: "fixture-state", url: "https://provider.example/device", flow: "device" });
          });
          const stored = new Map();
          const controller = new HomeAccountAcquisitions({
            get: async (key) => stored.get(key), put: async (key, value) => stored.set(key, value),
            getAlarm: async () => null, setAlarm: async () => {},
          }, home, "ab".repeat(32), { begin: async () => "fixture-marker", settle: async () => {} });
          const response = await controller.handle(request);
          return Response.json({ status: response.status, delivered, cancelled, calls });
        } };`,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts", sourcefile: "account-acquisition-ingress.ts",
    }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2023",
  });
  const worker = new Miniflare({ modules: true, script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"] });
  try {
    const overflow = await worker.dispatchFetch("https://fixture/pool/v1/account-acquisitions", {
      method: "POST", body: new Uint8Array(4 * 1024 * 1024),
    });
    assert.deepEqual(await overflow.json(), { status: 403, delivered: 32_769, cancelled: true, calls: 0 });
    const at = Date.now();
    const body = JSON.stringify({ envelope: await signEnvelope("ab".repeat(32), accountAcquisitionPrefix, {
      owner: "organization:fixture", operation: "fixture-start", action: "start", provider: "gemini-cli", at, expiresAt: at + 30_000,
    }) });
    const started = await worker.dispatchFetch("https://fixture/pool/v1/account-acquisitions", { method: "POST", body });
    assert.deepEqual(await started.json(), { status: 200, delivered: Buffer.byteLength(body), cancelled: false, calls: 2 });
  } finally { await worker.dispose(); }
});
