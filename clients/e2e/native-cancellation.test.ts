import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { command } from "./support.ts";
import { fixture } from "./native-client-fixture.ts";

test(
  "cancelling native access validation leaves the next request usable without reconnect",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await f.login();
      await command(["agent", "add", "both", "models", "tools"], f.home);
      const origin = await f.start(),
        token = await f.token();
      const held = f.remote.holdAccess(),
        abort = new AbortController();
      try {
        const cancelled = fetch(`${origin}/v1/models`, {
          headers: { authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        const rejected = assert.rejects(cancelled, /abort/u);
        await held.arrived;
        abort.abort();
        await rejected;
        await held.cancelled;
      } finally {
        held.release();
      }
      const next = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
      });
      assert.equal(
        next.status,
        200,
        "A cancelled access check must not disconnect a usable native grant.",
      );
      assert.match(await next.text(), /synthetic-tool-receipt/u);
      assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "connected");
    } finally {
      await f.close();
    }
  },
);

test(
  "cancelling an older access check leaves another request's successful renewal usable",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      f.remote.expireNext(60);
      await f.login();
      await command(["agent", "add", "both", "models", "tools"], f.home);
      const clock = join(f.home, "clock.now"),
        preload = join(f.home, "clock.mjs");
      await writeFile(clock, String(Date.now()));
      // Advance the refresh threshold without changing timers or requiring a prepared upstream checkout.
      await writeFile(
        preload,
        `import { readFileSync } from "node:fs";
        Date.now = () => Number(readFileSync(new URL("./clock.now", import.meta.url), "utf8"));`,
      );
      const origin = await f.start(["--import", preload]),
        token = await f.token();
      const heldAccess = f.remote.holdAccess(),
        heldRefresh = f.remote.holdRefresh();
      const abort = new AbortController(),
        headers = { authorization: `Bearer ${token}` };
      try {
        const cancelled = fetch(`${origin}/v1/models`, { headers, signal: abort.signal });
        const rejected = assert.rejects(cancelled, /abort/u);
        await heldAccess.arrived;
        const credentials = JSON.parse(await readFile(join(f.home, "credentials.json"), "utf8"));
        f.remote.expireNext(3600);
        await writeFile(clock, String(credentials.expiresAt - 20000));
        const renewing = fetch(`${origin}/v1/models`, { headers });
        await heldRefresh.arrived;
        abort.abort();
        await rejected;
        await heldAccess.cancelled;
        heldAccess.release();
        heldRefresh.release();
        const renewed = await renewing;
        assert.equal(
          JSON.parse(await readFile(join(f.home, "credentials.json"), "utf8")).refreshPending,
          false,
          "The other request successfully persisted its rotated credentials.",
        );
        assert.equal(
          renewed.status,
          200,
          "Cancelling the older access check must not poison successful renewal.",
        );
        await renewed.body?.cancel();
        const next = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
        });
        assert.equal(next.status, 200);
        assert.match(await next.text(), /synthetic-tool-receipt/u);
        assert.equal(f.remote.counts().refreshes, 1);
        assert.equal(JSON.parse((await command(["status"], f.home)).stdout).state, "connected");
      } finally {
        heldAccess.release();
        heldRefresh.release();
      }
    } finally {
      await f.close();
    }
  },
);
