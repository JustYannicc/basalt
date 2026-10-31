import assert from "node:assert/strict";
import { test } from "node:test";
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
