import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { Context, Effect, FileSystem, Layer, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { appOriginTls } from "../.upstream/e2e/support/app-origin-tls.ts";
import { BrowserDriver } from "../.upstream/e2e/support/browser.ts";
import { fixtureBrowser } from "../.upstream/e2e/support/browser-launch.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";

test("saved evidence can launch a browser without a live target", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const services = yield* Layer.build(BrowserDriver.layer);
      const browser = Context.get(services, BrowserDriver);
      const page = yield* Effect.promise(() => browser.newPage());
      assert.equal(
        yield* Effect.promise(() => page.evaluate(() => document.location.href)),
        "about:blank",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

test("fixture browsers trust their certificate at launch and reject unrelated certificates", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "browser-trust-" });
      const trusted = yield* appOriginTls;
      const unrelated = yield* appOriginTls;
      const upstream = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = createServer((request, response) => {
            if (request.url?.startsWith("/style.css")) {
              response.writeHead(200, { "content-type": "text/css" });
              response.end("body { background: rgb(1, 2, 3) }");
            } else {
              response.writeHead(200, { "content-type": "text/html" });
              response.end('<!doctype html><link rel="stylesheet" href="/style.css"><body>fixture');
            }
          });
          server.listen(0, "127.0.0.1");
          await once(server, "listening");
          return server;
        }),
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
      const origin = `http://127.0.0.1:${address.port}`;
      trusted.forward(origin);
      unrelated.forward(origin);
      const target = Target.of({
        directory,
        apiKey: Redacted.make("synthetic-fixture-api-key"),
        rows: 1,
        recordingPaceMs: 0,
        observeUI: false,
        headless: true,
        tlsCertificate: trusted.certificate,
        metadata: {
          target: "self-host",
          origin: trusted.origin,
          mode: "managed",
          runtime: "Fixture trust proof",
          commit: "synthetic",
          dirty: false,
          startedAt: "2026-01-01T00:00:00.000Z",
          interactive: false,
          diagnostics: "diagnostics/index.html",
        },
      });
      const services = yield* Layer.build(
        BrowserDriver.layer.pipe(Layer.provide(Layer.succeed(Target, target))),
      );
      const pinned = Context.get(services, BrowserDriver);
      const browserContext = yield* Effect.acquireRelease(
        Effect.promise(() => pinned.newContext()),
        (context) => Effect.promise(() => context.close()),
      );
      yield* Effect.promise(async () => {
        const page = await browserContext.newPage();
        assert.equal((await page.goto(trusted.origin))?.status(), 200);
        const styles = await page.evaluate(async () =>
          Promise.all(
            Array.from({ length: 40 }, (_, index) =>
              fetch(`/style.css?request=${index}`).then((response) => ({
                status: response.status,
                type: response.headers.get("content-type"),
              })),
            ),
          ),
        );
        assert.ok(styles.every((style) => style.status === 200 && style.type === "text/css"));
        assert.equal(
          await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
          "rgb(1, 2, 3)",
        );
        await assert.rejects(page.goto(unrelated.origin), /ERR_CERT_AUTHORITY_INVALID/);
      });
      assert.equal(yield* fixtureBrowser(pinned, target), pinned);
      // Shared suites launch before a case allocates its certificate.
      const sharedServices = yield* Layer.build(Layer.fresh(BrowserDriver.layer));
      const shared = Context.get(sharedServices, BrowserDriver);
      const scoped = yield* fixtureBrowser(shared, target);
      assert.notEqual(scoped, shared);
      yield* Effect.promise(async () => {
        const page = await scoped.newPage();
        assert.equal((await page.goto(trusted.origin))?.status(), 200);
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
