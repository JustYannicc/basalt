import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { accountAcquisitionPrefix } from "../../src/pool/account-acquisition-contract.ts";
import { signEnvelope } from "../../src/pool/token.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");

const refusal = { status: 403, delivered: 32_769, cancelled: true, calls: 0 };

async function proveOverflow(
  upload: () => Promise<{ json(): Promise<unknown> }>,
  observe: () => Promise<unknown>,
) {
  let parsed: { value: unknown } | undefined;
  try {
    const response = await upload();
    parsed = { value: await response.json() };
  } catch (error) {
    assert.ok(
      error instanceof TypeError &&
        error.cause instanceof Error &&
        "code" in error.cause &&
        (error.cause.code === "EPIPE" || error.cause.code === "ECONNRESET") &&
        "syscall" in error.cause &&
        error.cause.syscall === "write",
      "Only EPIPE or ECONNRESET while writing the oversized upload may lose its reply",
    );
  }
  if (parsed) assert.deepEqual(parsed.value, refusal);
  // A transport refusal alone cannot prove the Worker enforced the byte limit.
  assert.deepEqual(await observe(), refusal);
}

for (const phase of ["dispatch", "body"] as const)
  for (const code of ["EPIPE", "ECONNRESET"] as const)
    test(`oversized upload accepts ${phase} ${code} only with the exact server refusal`, async () => {
      const failure = new TypeError("terminated", {
        cause: Object.assign(new Error("write refused"), { code, syscall: "write" }),
      });
      const upload = async () => {
        if (phase === "dispatch") throw failure;
        return {
          json: async () => {
            throw failure;
          },
        };
      };
      let reads = 0;
      await proveOverflow(upload, async () => {
        reads++;
        return refusal;
      });
      assert.equal(reads, 1);
      for (const wrong of [
        { ...refusal, status: 200 },
        { ...refusal, delivered: 32_770 },
        { ...refusal, cancelled: false },
        { ...refusal, calls: 1 },
      ])
        await assert.rejects(
          proveOverflow(upload, async () => wrong),
          assert.AssertionError,
        );
    });

test("oversized upload rejects unrelated transport failures and incorrect parsed replies", async () => {
  for (const failure of [
    new Error("unrelated"),
    new TypeError("terminated", {
      cause: Object.assign(new Error("refused"), { code: "ETIMEDOUT", syscall: "write" }),
    }),
    new TypeError("terminated", {
      cause: Object.assign(new Error("refused"), { code: "EPIPE", syscall: "read" }),
    }),
  ])
    await assert.rejects(
      proveOverflow(
        async () => {
          throw failure;
        },
        async () => refusal,
      ),
      assert.AssertionError,
    );
  for (const value of [undefined, { ...refusal, delivered: 4 * 1024 * 1024 }])
    await assert.rejects(
      proveOverflow(
        async () => ({ json: async () => value }),
        async () => refusal,
      ),
      assert.AssertionError,
    );
});

test("a parsed refusal still requires the independent Worker proof", async () => {
  let reads = 0;
  const upload = async () => ({ json: async () => refusal });
  await proveOverflow(upload, async () => {
    reads++;
    return refusal;
  });
  assert.equal(reads, 1);
  await assert.rejects(
    proveOverflow(upload, async () => ({ ...refusal, cancelled: false })),
    assert.AssertionError,
  );
  await assert.rejects(
    proveOverflow(upload, async () => {
      throw new Error("proof unavailable");
    }),
    /proof unavailable/,
  );
});

test(
  "real Worker acquisition ingress caps delivered bytes before accepting a signed start",
  { timeout: 20_000 },
  async () => {
    const bundle = await build({
      stdin: {
        contents: `import { HomeAccountAcquisitions } from "./src/pool/account-acquisition.ts";
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
          const proof = { status: response.status, delivered, cancelled, calls };
          if (response.status === 403) overflowProof.resolve(proof);
          return Response.json(proof);
        } };`,
        resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
        loader: "ts",
        sourcefile: "account-acquisition-ingress.ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2023",
    });
    const worker = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-08-06",
      compatibilityFlags: ["nodejs_compat"],
    });
    try {
      await proveOverflow(
        () =>
          worker.dispatchFetch("https://fixture/pool/v1/account-acquisitions", {
            method: "POST",
            body: new Uint8Array(4 * 1024 * 1024),
          }),
        async () => {
          const observed = await worker.dispatchFetch("https://fixture/proof/overflow");
          return observed.json();
        },
      );
      const at = Date.now();
      const body = JSON.stringify({
        envelope: await signEnvelope("ab".repeat(32), accountAcquisitionPrefix, {
          owner: "organization:fixture",
          operation: "fixture-start",
          action: "start",
          provider: "gemini-cli",
          at,
          expiresAt: at + 30_000,
        }),
      });
      const started = await worker.dispatchFetch("https://fixture/pool/v1/account-acquisitions", {
        method: "POST",
        body,
      });
      assert.deepEqual(await started.json(), {
        status: 200,
        delivered: Buffer.byteLength(body),
        cancelled: false,
        calls: 2,
      });
    } finally {
      await worker.dispose();
    }
  },
);
