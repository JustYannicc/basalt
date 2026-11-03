import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// This exercises the runner's transport through real TCP/HTTP, without importing product services.
test("Cloud owns its canonical origin through forwarding, replacement and teardown", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";
    import { createServer as tcpServer } from "node:net";
    import { once } from "node:events";
    import { Effect } from "effect";
    import { cloudListener, cloudApiAddress } from "./e2e/support/cloud-listener.ts";
    const bind = (server, port, host = "127.0.0.1") => new Promise(resolve => {
      server.once("error", error => resolve(error.code));
      server.listen(port, host, () => server.close(() => resolve("listening")));
    });
    const backend = createServer((req, res) => res.end(req.headers.host));
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    let port;
    try {
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const listener = yield* cloudListener;
        port = Number(listener.url.port);
        assert.equal(yield* Effect.promise(() => bind(tcpServer(), port)), "EADDRINUSE");
        const ipv6 = yield* Effect.promise(() => bind(tcpServer(), port, "::1"));
        assert.ok(["EADDRINUSE", "EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(ipv6));
        const target = new URL("http://127.0.0.1:" + backend.address().port);
        yield* listener.set(target);
        assert.equal(yield* Effect.promise(() => fetch(listener.url).then(r => r.text())), listener.url.host);
        yield* listener.unset();
        yield* listener.set(target);
        assert.equal(yield* Effect.promise(() => fetch(listener.url).then(r => r.text())), listener.url.host);
        assert.equal(cloudApiAddress("[Api] Started in 1ms → " + target + " (logs: test)").port, target.port);
        assert.equal(cloudApiAddress("[McpServer] Started in 1ms → " + target + " (logs: test)"), undefined);
      })));
      assert.equal(await bind(tcpServer(), port), "listening");
    } finally {
      backend.closeAllConnections();
      await new Promise(resolve => backend.close(resolve));
    }
  `], {
    cwd: fileURLToPath(new URL("../.upstream/", import.meta.url)),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
