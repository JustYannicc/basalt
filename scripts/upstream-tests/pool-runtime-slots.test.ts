import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

import { Miniflare } from "../pool-test-runtime/index.ts";

test("real DO transactions retain selection and real Worker sockets survive failed staging then revoke on both slots", async () => {
  const previousCode = { candidate: "a".repeat(40), workerInput: "1".repeat(64) };
  const currentCode = { candidate: "b".repeat(40), workerInput: "2".repeat(64) };
  const compile = async (code: typeof previousCode) =>
    build({
      entryPoints: [
        fileURLToPath(new URL("../pool-tests/runtime-slots-worker.mjs", import.meta.url)),
      ],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2023",
      external: ["cloudflare:workers"],
      define: { "globalThis.FIXTURE_CONTROLLER_CODE": JSON.stringify(code) },
    });
  const previousScript = (await compile(previousCode)).outputFiles[0]!.text;
  const currentScript = (await compile(currentCode)).outputFiles[0]!.text;
  assert.notEqual(previousScript, currentScript);
  const options = (script: string) => ({
    modules: true,
    script,
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      Controller: { className: "Controller", useSQLite: true },
      NODE: { className: "ModelLifetimeNode", useSQLite: true },
    },
  });
  const mf = new Miniflare(options(previousScript));
  const request = (path: string, body?: unknown) =>
    mf.dispatchFetch(`https://fixture${path}`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
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
    await mf.setOptions(options(currentScript));
    const adopted = (await (await request("/inspect")).json()) as {
      snapshot: {
        controllerCode: typeof currentCode;
        selection: { active: { identity: { bootId: string } } };
      };
      calls: { start: number; retire: number };
    };
    assert.deepEqual(adopted.snapshot.controllerCode, currentCode);
    assert.equal(adopted.snapshot.selection.active.identity.bootId, "boot-old");
    assert.equal(adopted.calls.start, 0);
    assert.equal(adopted.calls.retire, 0);
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
    assert.equal((await request("/promote-old-code", previousCode)).status, 503);
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
