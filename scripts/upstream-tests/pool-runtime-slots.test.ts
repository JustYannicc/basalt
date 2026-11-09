import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");

test("real DO transactions retain selection and real Worker sockets survive failed staging then revoke on both slots", async () => {
  const bundle = await build({
    entryPoints: [
      fileURLToPath(new URL("../pool-tests/runtime-slots-worker.mjs", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    external: ["cloudflare:workers"],
  });
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { Controller: { className: "Controller", useSQLite: true } },
  });
  const request = (path: string) => mf.dispatchFetch(`https://fixture${path}`, { method: "POST" });
  const socket = async () => {
    const response = await mf.dispatchFetch("https://fixture/socket", {
      headers: { Upgrade: "websocket" },
    });
    assert.equal(response.status, 101);
    const ws = response.webSocket!;
    ws.accept();
    const first = new Promise<string>((resolve) =>
      ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
    );
    return {
      ws,
      boot: await first,
      closed: new Promise<void>((resolve) =>
        ws.addEventListener("close", () => resolve(), { once: true }),
      ),
    };
  };
  try {
    assert.equal((await request("/seed")).status, 200);
    const old = await socket();
    assert.equal(old.boot, "boot-old");
    assert.equal((await request("/stage-failure")).status, 503);
    const duringFailure = await socket();
    assert.equal(duringFailure.boot, "boot-old");
    const echo = new Promise<string>((resolve) =>
      old.ws.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
    );
    old.ws.send("old is still serving");
    assert.equal(await echo, "old is still serving");
    const promoted = (await (await request("/promote")).json()) as {
      receipts: { status: string }[];
      calls: { start: number; install: number };
    };
    assert.ok(promoted.receipts.some((receipt) => receipt.status === "promoted"));
    assert.ok(
      promoted.receipts.every((receipt) => ["started", "promoted"].includes(receipt.status)),
    );
    assert.equal(promoted.calls.start, 1);
    const current = await socket();
    assert.equal(current.boot, "boot-candidate");
    assert.equal((await request("/reconstruct")).status, 200);
    const rollback = await request("/atomic-rollback");
    assert.equal(rollback.status, 503);
    const inspect = (await (await request("/inspect")).json()) as {
      snapshot: { selection: { epoch: number; active: { identity: { bootId: string } } } };
      rollbackSentinel: unknown;
    };
    assert.equal(inspect.snapshot.selection.epoch, 2);
    assert.equal(inspect.snapshot.selection.active.identity.bootId, "boot-candidate");
    assert.equal(inspect.rollbackSentinel, null);
    assert.equal((await request("/revoke")).status, 200);
    await Promise.all([old.closed, duringFailure.closed, current.closed]);
    const deniedHttp = await request("/socket");
    assert.equal(deniedHttp.status, 503);
    assert.deepEqual(await deniedHttp.json(), { error: "Native pool membership is refreshing" });
    const refused = await mf.dispatchFetch("https://fixture/socket", {
      headers: { Upgrade: "websocket" },
    });
    assert.equal(refused.status, 503, await refused.text());
  } finally {
    await mf.dispose();
  }
});
