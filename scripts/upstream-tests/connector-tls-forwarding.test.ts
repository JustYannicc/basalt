import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Agent, request } from "node:https";
import { test } from "node:test";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { appOriginTls } from "../../.upstream/e2e/support/app-origin-tls.ts";

test("the TLS fixture keeps independent requests off a closed reused upstream connection", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const tls = yield* appOriginTls;
      const upstream = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
              const seen = new WeakSet();
              const server = createServer((incoming, outgoing) => {
                // A peer may close a reused connection before the forwarding agent observes it.
                // Make that race deterministic without clocks, sleeps or retrying a request.
                if (seen.has(incoming.socket)) {
                  incoming.socket.destroy();
                  return;
                }
                seen.add(incoming.socket);
                outgoing.writeHead(200, { "content-type": "application/json" });
                outgoing.end('{"ok":true}');
              });
              server.once("error", reject);
              server.listen(0, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
      );
      const address = upstream.address();
      assert.ok(address !== null && typeof address !== "string");
      tls.forward(`http://127.0.0.1:${address.port}`);
      const agent = new Agent({
        keepAlive: true,
        ca: readFileSync(tls.certificate),
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => agent.destroy()));
      const get = () =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const incoming = request(`${tls.origin}/tool`, { agent }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          });
          incoming.once("error", reject);
          incoming.end();
        });
      assert.deepEqual(yield* Effect.promise(get), { status: 200, body: '{"ok":true}' });
      assert.deepEqual(yield* Effect.promise(get), { status: 200, body: '{"ok":true}' });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
