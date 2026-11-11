import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, launch } from "./support.ts";
import { ready } from "./native-client-fixture.ts";
import { nativeFixture } from "./native-fixture.ts";

test(
  "native requests recover from a deploy window without Reconnect or replay",
  { timeout: 30000 },
  async () => {
    const remote = await nativeFixture();
    const home = await mkdtemp(join(tmpdir(), "client-access-recovery-"));
    let runtime: ReturnType<typeof launch> | undefined;
    try {
      const login = launch(
        [
          "login",
          remote.origin,
          "--no-browser",
          "--storage",
          process.platform === "linux" ? "file" : "os",
        ],
        home,
      );
      await ready(login, /Confirmation code: BCDF-GHJK/u);
      remote.approve();
      assert.equal((await login.exited).code, 0);
      await command(["agent", "add", "both", "models", "tools"], home);
      runtime = launch(["run"], home);
      await ready(runtime, /Connection ready at /u);
      const { origin } = JSON.parse(await readFile(join(home, "runtime.json"), "utf8"));
      const { token } = JSON.parse(await readFile(join(home, "agent-both.json"), "utf8"));
      const request = (path: string, extraHeaders: Record<string, string> = {}) =>
        fetch(`${origin}${path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...extraHeaders,
          },
          body: JSON.stringify(
            path === "/mcp"
              ? { jsonrpc: "2.0", id: 1, method: "tools/call" }
              : { model: "synthetic-model" },
          ),
        });
      const invalidate = async () => {
        remote.accessLifetime(60);
        remote.refuseNextUpgrade();
        const refused = await request("/mcp");
        assert.equal(
          refused.status,
          503,
          "A rejected handshake invalidates the cached grant before dispatch.",
        );
        await refused.body?.cancel();
        remote.accessLifetime(3600);
      };
      await invalidate();
      const before = remote.counts();
      remote.unavailableAccess(2);
      const recovered = await request("/mcp");
      assert.equal(
        recovered.status,
        200,
        "A bounded authorization read retry crosses a brief deploy window.",
      );
      assert.match(await recovered.text(), /synthetic-tool-receipt/u);
      assert.equal(remote.counts().accessReads, before.accessReads + 3);
      assert.equal(
        remote.counts().writes,
        before.writes + 1,
        "Only authorization reads are retried.",
      );

      await invalidate();
      remote.unavailableAccess(6);
      const prior = remote.counts();
      for (const path of ["/v1/responses", "/mcp"]) {
        const response = await request(path);
        assert.equal(response.status, 503, "A pre-dispatch failure is safe to retry.");
        assert.equal(response.headers.get("retry-after"), "1");
        assert.notEqual(response.headers.get("x-should-retry"), "false");
        const body = await response.json();
        if (path === "/mcp") {
          assert.equal(body.jsonrpc, "2.0");
          assert.equal(body.error.data.retryable, true);
        }
        assert.doesNotMatch(JSON.stringify(body), /unknown|not replayed/u);
      }
      assert.equal(
        remote.counts().accessReads,
        prior.accessReads + 6,
        "Read retries are bounded per request.",
      );
      assert.equal(remote.counts().operationOpens, prior.operationOpens);
      assert.equal(remote.counts().writes, prior.writes);
      const afterWindow = await request("/mcp");
      assert.equal(afterWindow.status, 200, "The next request recovers without a local Reconnect.");
      await afterWindow.body?.cancel();

      remote.offline(true);
      const offline = await request("/mcp");
      assert.equal(offline.status, 503);
      await offline.body?.cancel();
      remote.offline(false);
      const backOnline = await request("/mcp");
      assert.equal(backOnline.status, 200, "A network failure does not latch disconnected state.");
      await backOnline.body?.cancel();

      const beforeInvalid = remote.counts();
      const invalid = await request("/mcp", { accept: "x".repeat(4097) });
      assert.equal(
        invalid.status,
        502,
        "Invalid local input is a permanent refusal before dispatch.",
      );
      assert.equal(invalid.headers.get("retry-after"), null);
      assert.equal(invalid.headers.get("x-should-retry"), "false");
      assert.doesNotMatch(await invalid.text(), /outcome.*unknown/iu);
      assert.equal(remote.counts().operationOpens, beforeInvalid.operationOpens);

      remote.dropTool(true);
      const beforeInterrupted = remote.counts();
      const interrupted = await request("/mcp");
      assert.equal(interrupted.status, 502, "A dispatched tool call retains its unknown outcome.");
      assert.equal(interrupted.headers.get("retry-after"), null);
      assert.match(await interrupted.text(), /outcome may be unknown/u);
      assert.equal(remote.counts().writes, beforeInterrupted.writes + 1);
      remote.dropTool(false);

      await invalidate();
      remote.denyAccess(true);
      const deniedBefore = remote.counts();
      const denied = await request("/mcp");
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("retry-after"), null);
      await denied.body?.cancel();
      assert.equal(
        remote.counts().accessReads,
        deniedBefore.accessReads + 1,
        "Authoritative refusal is never retried.",
      );
      assert.equal(JSON.parse((await command(["status"], home)).stdout).state, "sign-in-required");
      remote.denyAccess(false);
      const stillDenied = await request("/mcp");
      assert.equal(stillDenied.status, 401);
      assert.equal(stillDenied.headers.get("retry-after"), null);
      await stillDenied.body?.cancel();
      assert.equal(remote.counts().accessReads, deniedBefore.accessReads + 1);
      remote.denyAccess(true, 403);
      const forbidden = await launch(["reconnect"], home).exited;
      assert.equal(forbidden.code, 1);
      assert.equal(JSON.parse((await command(["status"], home)).stdout).state, "sign-in-required");
      assert.equal(remote.counts().accessReads, deniedBefore.accessReads + 2);
    } finally {
      remote.offline(false);
      if (runtime) {
        await command(["sign-out"], home).catch(() => undefined);
        runtime.child.kill("SIGTERM");
        assert.equal((await runtime.exited).code, 0);
      }
      await remote.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
