import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { command, launch } from "./support.ts";
import { ready } from "./native-client-fixture.ts";
import { nativeFixture } from "./native-fixture.ts";

test(
  "health detects idle network loss, keeps deliberate disconnect distinct and recovers without replay",
  { timeout: 20000 },
  async () => {
    const remote = await nativeFixture();
    const home = await mkdtemp(join(tmpdir(), "client-health-"));
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
      const signedIn = await login.exited;
      assert.equal(signedIn.code, 0, signedIn.stderr);
      const clock = join(home, "clock.now"),
        preload = join(home, "clock.mjs");
      const now = Date.now();
      await writeFile(clock, String(now));
      await writeFile(
        preload,
        `import { readFileSync } from "node:fs";
      Date.now = () => Number(readFileSync(new URL("./clock.now", import.meta.url), "utf8"));`,
      );
      runtime = launch(["run"], home, ["--import", preload]);
      await ready(runtime, /Connection ready at /u);
      const health = async () => JSON.parse((await command(["health"], home)).stdout);
      const online = await health();
      assert.equal(online.health.state, "online");
      const reads = remote.counts().healthReads;
      await health();
      assert.equal(remote.counts().healthReads, reads, "Fresh observations are cached.");
      remote.offline(true);
      await writeFile(clock, String(now + 11000));
      const offline = await health();
      assert.equal(
        offline.state,
        "connected",
        "A reachability check preserves the saved grant state.",
      );
      assert.equal(offline.health.state, "offline");
      assert.equal(offline.health.checkedAt, now + 11000);
      assert.equal(remote.counts().writes, 0, "Health checks never invoke application tools.");
      await command(["disconnect"], home);
      const intentional = await health();
      assert.equal(intentional.state, "disconnected");
      assert.equal(intentional.health, undefined);
      remote.offline(false);
      await command(["reconnect"], home);
      assert.equal((await health()).health.state, "online");
      const { origin } = JSON.parse(await readFile(join(home, "runtime.json"), "utf8"));
      await command(["agent", "add", "agent", "models"], home);
      const { token } = JSON.parse(await readFile(join(home, "agent-agent.json"), "utf8"));
      const forbidden = await fetch(`${origin}/client/health`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(forbidden.status, 401);
      await forbidden.body?.cancel();
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

test(
  "direct health checks only server reachability and never send stored keys",
  { timeout: 15000 },
  async () => {
    let offline = false,
      probes = 0;
    const server = createServer((request, response) => {
      if (offline) {
        request.socket.destroy();
        return;
      }
      assert.equal(request.method, "HEAD");
      assert.equal(request.url, "/");
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["x-api-key"], undefined);
      probes++;
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const home = await mkdtemp(join(tmpdir(), "client-direct-health-"));
    let runtime: ReturnType<typeof launch> | undefined;
    try {
      const origin = `http://127.0.0.1:${address.port}`;
      const input = join(home, "input.json"),
        clock = join(home, "clock.now"),
        preload = join(home, "clock.mjs");
      await writeFile(
        input,
        JSON.stringify({
          version: 1,
          mode: "direct",
          models: { origin, token: "synthetic-private-model-key" },
          tools: { origin, path: "/mcp", token: "ext_synthetic-private-tools-key" },
        }),
        { mode: 0o600 },
      );
      await command(
        ["import-direct", input, "--storage", process.platform === "linux" ? "file" : "os"],
        home,
      );
      const now = Date.now();
      await writeFile(clock, String(now));
      await writeFile(
        preload,
        `import { readFileSync } from 'node:fs'; Date.now = () => Number(readFileSync(new URL('./clock.now', import.meta.url), 'utf8'));`,
      );
      runtime = launch(["run"], home, ["--import", preload]);
      await ready(runtime, /Connection ready at /u);
      const health = async () => JSON.parse((await command(["health"], home)).stdout);
      assert.equal((await health()).health.state, "online");
      assert.equal(probes, 1, "Shared model/tools origin needs one reachability probe.");
      offline = true;
      await writeFile(clock, String(now + 11000));
      assert.equal((await health()).health.state, "offline");
      offline = false;
      await writeFile(clock, String(now + 22000));
      assert.equal((await health()).health.state, "online");
    } finally {
      if (runtime) {
        await command(["sign-out"], home).catch(() => undefined);
        runtime.child.kill("SIGTERM");
        assert.equal((await runtime.exited).code, 0);
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
);
