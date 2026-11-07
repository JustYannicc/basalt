import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Redacted } from "effect";
import { Browser, BrowserDriver } from "../.upstream/e2e/support/browser.ts";
import { Evidence } from "../.upstream/e2e/support/evidence.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";
import { RecordingFocus } from "../.upstream/e2e/support/recording-focus.ts";

const { chromium } = createRequire(new URL("../.upstream/package.json", import.meta.url))(
  "playwright",
);

async function fixture(t, dashboard = true, incomplete = false) {
  const directory = await mkdtemp(join(tmpdir(), "driver-hydration-"));
  await mkdir(join(directory, "raw"));
  const documents = new Map();
  const clicks = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const document = documents.get(url.searchParams.get("id"));
    if (url.pathname === "/hydrate") {
      await document.ready;
      response.end("ready");
      return;
    }
    if (url.pathname === "/checked") {
      document.release();
      response.end();
      return;
    }
    if (url.pathname === "/clicked") {
      clicks.push(url.searchParams.get("ready") === "true");
      response.end();
      return;
    }
    const id = String(sequence++);
    let release;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    documents.set(id, { ready, release });
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><html ${dashboard ? "data-dashboard" : ""}><body>
      <button>Open connection</button><div role="dialog" hidden>Client ID</div>
      <script>
        ${incomplete ? "Object.defineProperty(window, '$_TSR', { configurable: false, value: undefined });" : ""}
        const root = document.documentElement;
        const original = root.hasAttribute.bind(root);
        root.hasAttribute = (name) => {
          if (name === 'data-hydrated') fetch('/checked?id=${id}');
          return original(name);
        };
        let hydrated = false;
        document.querySelector('button').onclick = () => {
          fetch('/clicked?id=${id}&ready=' + hydrated);
          if (hydrated || ${!dashboard}) document.querySelector('[role=dialog]').hidden = false;
        };
        fetch('/hydrate?id=${id}').then(() => {
          hydrated = true;
          root.setAttribute('data-hydrated', '');
        });
      </script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let native;
  t.after(async () => {
    for (const document of documents.values()) document.release();
    await native?.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  });
  native = await chromium.launch({ headless: true });
  const target = Target.of({
    metadata: {
      target: "local",
      origin,
      mode: "managed",
      runtime: "fixture",
      commit: "fixture",
      dirty: false,
      startedAt: "2026-11-07T00:00:00Z",
      interactive: false,
      diagnostics: "fixture",
    },
    directory,
    apiKey: Redacted.make("fixture"),
    rows: 1,
    observeUI: false,
    recordingPaceMs: 0,
  });
  const evidence = Evidence.of({
    directory,
    attach: () => Effect.void,
    json: () => Effect.void,
    artifact: () => Effect.void,
    sending: () => Effect.void,
    request: () => Effect.void,
    requests: Effect.succeed([]),
    browserTrace: () => Effect.void,
    failed: () => Effect.void,
    intervention: () => Effect.void,
    step: (_name, program) => program,
    flush: Effect.void,
  });
  const run = (operation) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const browser = yield* Browser;
          return yield* operation(browser);
        }),
      ).pipe(
        Effect.provide(Browser.layer),
        Effect.provide(RecordingFocus.layer),
        Effect.provideService(BrowserDriver, native),
        Effect.provideService(Target, target),
        Effect.provideService(Evidence, evidence),
        Effect.provide(NodeServices.layer),
      ),
      { signal: t.signal },
    );
  return { run, clicks };
}

const clickAndRead = async (page) => {
  const sent = page.waitForResponse((response) => new URL(response.url()).pathname === "/clicked");
  await page.getByRole("button", { name: "Open connection", exact: true }).click();
  await sent;
  return page.getByRole("dialog").isVisible();
};

test("a navigation and click in one Browser.use wait for the delayed document hydration", async (t) => {
  const f = await fixture(t);
  const opened = await f.run((browser) =>
    browser.use("Navigate and open", (page) => page.goto("/first").then(() => clickAndRead(page))),
  );
  assert.equal(opened, true, "the click must reach a hydrated document, not inert server markup");
  assert.deepEqual(f.clicks, [true]);
});

test("a reload and click in one Browser.use wait for the replacement document hydration", async (t) => {
  const f = await fixture(t);
  const opened = await f.run((browser) =>
    Effect.gen(function* () {
      yield* browser.use("Open the initial document", (page) => page.goto("/first"));
      return yield* browser.use("Reload and open", (page) =>
        page.reload().then(() => clickAndRead(page)),
      );
    }),
  );
  assert.equal(opened, true, "the replacement document must hydrate before its click");
  assert.deepEqual(f.clicks, [true]);
});

test("an explicit commit navigation preserves an intentional pre-hydration interaction", async (t) => {
  const f = await fixture(t);
  const opened = await f.run((browser) =>
    browser.use("Inspect before hydration", (page) =>
      page.goto("/first", { waitUntil: "commit" }).then(() => clickAndRead(page)),
    ),
  );
  assert.equal(opened, false);
  assert.deepEqual(f.clicks, [false]);
});

test("navigation to a page outside the dashboard does not wait for dashboard hydration", async (t) => {
  const f = await fixture(t, false);
  const opened = await f.run((browser) =>
    browser.use("Open an outside sign-in page", (page) =>
      page.goto("/outside").then(() => clickAndRead(page)),
    ),
  );
  assert.equal(opened, true);
  assert.deepEqual(f.clicks, [false]);
});

test("explicit commit plus load retains a deliberately incomplete document for its assertions", async (t) => {
  const f = await fixture(t, true, true);
  const observed = await f.run((browser) =>
    browser.use("Read startup failure before hydration", async (page) => {
      await page.goto("/incomplete", { waitUntil: "commit" });
      await page.waitForLoadState("load");
      const held = await page.evaluate(() => "$_TSR" in window);
      await page.goto("about:blank");
      return held;
    }),
  );
  assert.equal(observed, true);
  assert.deepEqual(f.clicks, []);
});
