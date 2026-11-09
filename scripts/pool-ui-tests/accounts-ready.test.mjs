import { PoolHome, HomeClient, accountsView } from "../../src/pool/control.ts";
import { overviewFixture, capacityFixture } from "./overview-fixture.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(join(root, ".upstream/package.json"));
const { chromium } = require("playwright");
const ready = { name: "basalt:pool-accounts-ready", version: 2, snapshot: false };
const failed = { ok: false, error: "backend_unavailable", message: "Synthetic pool failure" };
const empty = { isOwner: true, providers: [], accounts: [] };
const emptyUsage = {
  ok: true,
  value: {
    scope: "pool",
    from: "2026-10-01T00:00:00Z",
    to: "2026-11-01T00:00:00Z",
    total: {
      requests: 0,
      cost: 0,
      unpriced: 0,
      tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    models: [],
    days: [],
    accounts: [],
    cap: null,
    readAt: null,
  },
};

// Optional PR evidence, never committed. Screenshots go to an absolute directory outside the checkout.
const artifacts = process.env.POOL_UI_ARTIFACTS;
// Optional baseline: build that commit's app.tsx, accounts.tsx and api.ts into the fixture instead of the working tree.
const sourceRef = process.env.POOL_UI_SOURCE_REF;
const subscriptionsBaseline = process.env.POOL_UI_SUBSCRIPTIONS_BASELINE === "1";
// Optional baseline: build that commit's overview.tsx and usage-groups.tsx to capture the old people copy.
const peopleCopyRef = process.env.POOL_UI_PEOPLE_COPY_REF;
const baselineRef = sourceRef ?? peopleCopyRef;
const artifactLabel =
  process.env.POOL_UI_ARTIFACT_LABEL ??
  (baselineRef ? `before-${baselineRef.slice(0, 8)}` : "after");
if (artifacts)
  assert.ok(
    isAbsolute(artifacts) && !`${resolve(artifacts)}/`.startsWith(root),
    "POOL_UI_ARTIFACTS must be an absolute directory outside the checkout",
  );

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const providers = [
  { id: "codex", name: "Codex" },
  { id: "claude", name: "Claude" },
];

/** A realistic three-seat pool. Provider observations keep their own times; `readAt` is Home's. */
function poolView(now, { source, revalidationFailed = false, observedAgo, savedAgo, left }) {
  const iso = (offset) => new Date(now + offset).toISOString();
  const observedAt = iso(-observedAgo);
  const seat = (id, provider, label, plan, [short, weekly]) => ({
    id,
    provider,
    label,
    plan,
    state: "active",
    message: null,
    windows: [
      {
        id: `${id}-5h`,
        label: "5 hours",
        remainingRatio: short,
        resetAt: iso(2 * hour + 14 * minute),
        windowSeconds: 5 * 3600,
        observedAt,
      },
      {
        id: `${id}-weekly`,
        label: "Weekly",
        remainingRatio: weekly,
        resetAt: iso(3 * day + 5 * hour),
        windowSeconds: 7 * 24 * 3600,
        observedAt,
      },
    ],
    observedAt,
    freshness: source === "snapshot" ? "stale" : "fresh",
    readingFailed: false,
    nextReadAt: iso(4 * minute),
    earliestResetAt: iso(2 * hour + 14 * minute),
    bankedResets: null,
  });
  return {
    ok: true,
    value: {
      isOwner: true,
      providers,
      reading: {
        source,
        revalidationFailed,
        readAt: {
          membership: iso(-savedAgo - 900),
          credentials: iso(-savedAgo - 400),
          quota: iso(-savedAgo),
        },
      },
      accounts: [
        seat("seat-build-1", "codex", "build-seat-1@example.com", "Pro", left[0]),
        seat("seat-build-2", "codex", "build-seat-2@example.com", "Plus", left[1]),
        seat("seat-review", "claude", "review-seat@example.com", "Max 5x", left[2]),
      ],
    },
  };
}

/** Runs in the parent and the pool frame before any page script. */
function instrument() {
  const mark = performance.mark.bind(performance);
  performance.mark = (name, options) => {
    const result = mark(name, options);
    if (name === "basalt:pool-accounts-ready")
      document.documentElement.dataset.committedAtReady = document.body.textContent ?? "";
    return result;
  };
  // What the page showed when each fresh view request left, to prove the retained view committed first.
  const followUps = [];
  const queries = [];
  const completed = [];
  Reflect.set(window, "completedQueries", completed);
  Reflect.set(window, "queries", queries);
  Reflect.set(window, "followUps", followUps);
  Reflect.set(window, "contextSends", 0);
  const send = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const shown = document.body?.textContent ?? "";
    const body = init?.body;
    const text =
      typeof body === "string"
        ? body
        : body instanceof Uint8Array || body instanceof ArrayBuffer
          ? new TextDecoder().decode(body)
          : null;
    let name;
    try {
      const operation = text === null ? null : JSON.parse(text);
      name =
        operation?.name ??
        (String(input).endsWith("/pool-usage/overview")
          ? "overviewUsage"
          : String(input).endsWith("/pool-usage/personal-overview")
            ? "personalOverview"
            : undefined);
      if (name) queries.push(name);
      if (operation?.name === "view" && operation.input?.fresh === true) followUps.push(shown);
      if (operation?.name === "computerContext")
        Reflect.set(window, "contextSends", Reflect.get(window, "contextSends") + 1);
    } catch {}
    return send(input, init).then((response) => {
      if (name) completed.push(name);
      return response;
    });
  };
}

// One file on purpose: every subtest shares this fixture's build, servers and tracked browser process.
test(
  "the committed pool view reports readiness once to its parent, including StrictMode, refresh and retained views",
  { timeout: 120_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "pool-ready-"));
    const servers = [];
    let held = [];
    let heldCapacity = [];
    let holdCapacity = false;
    let capacityReply = capacityFixture;
    let member = false;
    let holdPersonal = false;
    let heldPersonal = [];
    let views = [];
    let contextReads = 0;
    let browserServer;
    let browser;
    let exited;
    let evidenceVideo;
    t.after(async () => {
      const problems = [];
      const step = async (work) => {
        try {
          await work();
        } catch (error) {
          problems.push(error);
        }
      };
      // Pending view responses are released first so no request outlives the fixture.
      for (const { response } of [
        ...held.splice(0),
        ...heldCapacity.splice(0),
        ...heldPersonal.splice(0),
      ])
        response.end(JSON.stringify(failed));
      if (artifacts && evidenceVideo)
        await step(() => evidenceVideo.saveAs(join(artifacts, `${artifactLabel}-transition.webm`)));
      await step(() => browser?.close());
      await step(() => browserServer?.close());
      if (browserServer)
        await step(async () => {
          const child = browserServer.process();
          let timer;
          const outcome = await Promise.race([
            exited,
            new Promise((resolve) => (timer = setTimeout(() => resolve("timeout"), 10_000))),
          ]);
          clearTimeout(timer);
          if (outcome === "timeout") {
            await browserServer.kill();
            await exited;
          }
          assert.notEqual(outcome, "timeout", `Browser process ${child.pid} outlived close`);
          assert.ok(
            child.exitCode !== null || child.signalCode !== null,
            `Browser process ${child.pid} still running`,
          );
          assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
          t.diagnostic(`Owned browser process ${child.pid} exited; no browser remains.`);
        });
      for (const server of servers)
        await step(() => {
          server.closeAllConnections();
          return new Promise((resolve) => server.close(() => resolve()));
        });
      await step(async () => require("esbuild").stop());
      rmSync(directory, { recursive: true, force: true });
      if (problems.length) throw new AggregateError(problems, "Fixture cleanup failed");
    });

    let childOrigin = "";
    const parent = createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      if (request.url === "/spoof") {
        response.end(
          `<script>parent.postMessage(${JSON.stringify(ready)}, location.origin)</script><p>Wrong origin sent</p>`,
        );
        return;
      }
      response.end(`<style>body{margin:0}iframe{display:block;border:0;width:100%;height:100vh}</style><script>
      window.readiness = [];
      window.rejected = 0;
      addEventListener('message', event => {
        if (event.data?.name !== 'basalt:pool-accounts-ready') return;
        const frame = document.querySelector('iframe');
        if (event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) { window.rejected++; return; }
        const data = event.data;
        if (data.version !== 2 || typeof data.snapshot !== 'boolean' || Object.keys(data).length !== 3) { window.rejected++; return; }
        window.readiness.push({ data, at: performance.now() });
      });
    </script><iframe src="${childOrigin}"></iframe>`);
    });
    servers.push(parent);
    await new Promise((resolve) => parent.listen(0, "127.0.0.1", resolve));
    const parentAddress = parent.address();
    assert.ok(parentAddress && typeof parentAddress !== "string");
    const parentOrigin = `http://127.0.0.1:${parentAddress.port}`;

    // Use the same source and entry point as the shipped app; only the deployment origin changes.
    const app = join(directory, "app");
    cpSync(join(root, "apps/pool"), app, {
      recursive: true,
      filter: (path) => !path.includes("node_modules") && !/\.(test|spec)\./.test(path),
    });
    if (sourceRef)
      for (const file of ["ui/app.tsx", "ui/accounts.tsx", "ui/api.ts"])
        writeFileSync(
          join(app, file),
          execFileSync("git", ["-C", root, "show", `${sourceRef}:apps/pool/${file}`]),
        );
    if (subscriptionsBaseline)
      for (const file of ["ui/overview.tsx", "ui/overview-attention.ts"])
        writeFileSync(
          join(app, file),
          execFileSync("git", ["-C", root, "show", `a434a2af:${`apps/pool/${file}`}`]),
        );
    if (peopleCopyRef)
      for (const file of ["ui/overview.tsx", "ui/usage-groups.tsx"])
        writeFileSync(
          join(app, file),
          execFileSync("git", ["-C", root, "show", `${peopleCopyRef}:apps/pool/${file}`]),
        );
    writeFileSync(
      join(app, "deployment.ts"),
      `export const poolOrigin = ${JSON.stringify(parentOrigin)}; export const productName = "Signalbox";`,
    );
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    );
    mkdirSync(join(app, "node_modules"));
    const webRequire = createRequire(join(root, ".upstream/apps/hosted/web/package.json"));
    for (const name of ["react", "react-dom", "tailwindcss"])
      symlinkSync(
        join(webRequire.resolve(`${name}/package.json`), ".."),
        join(app, "node_modules", name),
        "dir",
      );
    symlinkSync(join(root, ".upstream/packages/apps"), join(app, "node_modules/apps"), "dir");
    const built = spawnSync(
      process.env.BUN_BINARY ?? "bun",
      [
        "-e",
        `
    const result = await Bun.build({ entrypoints: [${JSON.stringify(join(app, "ui/main.tsx"))}],
      outdir: ${JSON.stringify(join(directory, "dist"))}, target: 'browser',
      define: { 'process.env.NODE_ENV': '"development"' } });
    if (!result.success) { console.error(result.logs); process.exit(1); }
  `,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stderr + built.stdout);
    const javascript = readFileSync(join(directory, "dist/main.js"));
    // Screenshots need the real stylesheet, compiled the way scripts/setup-build.ts compiles it.
    const stylesheet = await compileStyles(app, javascript.toString("utf8"));

    let arrived = () => {};
    let viewResult = failed;
    // When set, fresh view requests get this instead of `viewResult`.
    let freshResult;
    // When set, fresh view requests are answered as they arrive instead of held.
    let answerFresh = false;
    let usageResult = emptyUsage;
    // When set, replaces the overview's people directory counts.
    let directoryResult;
    const answer = (entry) =>
      entry.response.end(
        JSON.stringify(entry.fresh && freshResult !== undefined ? freshResult : viewResult),
      );
    const child = createServer(async (request, response) => {
      if (request.url === "/main.js") {
        response.setHeader("content-type", "application/javascript");
        response.end(javascript);
      } else if (request.url === "/main.css" && stylesheet !== null) {
        response.setHeader("content-type", "text/css");
        response.end(stylesheet);
      } else if (
        [
          "/_executor/api/pool-usage/overview",
          "/_executor/api/pool-usage/personal-overview",
        ].includes(request.url)
      ) {
        let body = "";
        for await (const chunk of request) body += chunk;
        response.setHeader("content-type", "application/json");
        const personal = request.url.endsWith("personal-overview");
        if (!personal && member) {
          response.writeHead(403).end();
          return;
        }
        if (!usageResult.ok) {
          response.writeHead(503).end();
          return;
        }
        const value = overviewFixture(JSON.parse(body).input, usageResult.value);
        if (directoryResult) value.directory = directoryResult;
        const tokens = usageResult.value.total.tokens.total;
        if (tokens > 0) {
          value.metrics.apiBilled = {
            ...value.metrics.apiBilled,
            status: "available",
            amount: String(usageResult.value.total.cost),
            pricedRequests: usageResult.value.total.requests,
            excluded: { unknownKind: 0, unknownKindValue: null, unpriced: 0 },
          };
          value.metrics.requestTokens = {
            ...value.metrics.requestTokens,
            status: "available",
            percentiles: { p50: tokens, p90: tokens, p99: tokens },
            requests: usageResult.value.total.requests,
          };
        }
        const reply = JSON.stringify(
          personal
            ? {
                from: value.from,
                to: value.to,
                asOf: value.asOf,
                consistency: value.consistency,
                person: "fixture-caller",
                series: {
                  ...value.models,
                  groups: value.models.groups.map((group) => ({
                    ...group,
                    key: { ...group.key, person: "fixture-caller" },
                  })),
                },
                metrics: value.metrics,
                partial: false,
              }
            : value,
        );
        if (personal && holdPersonal) heldPersonal.push({ response, reply });
        else response.end(reply);
      } else if (request.url === "/_executor/api/query") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const { name, input } = JSON.parse(body);
        response.setHeader("content-type", "application/json");
        if (name === "capacity" && holdCapacity) {
          heldCapacity.push({ response, input });
        } else if (name === "view") {
          const entry = { response, fresh: input?.fresh === true };
          views.push({ fresh: entry.fresh });
          if (entry.fresh && answerFresh) answer(entry);
          else held.push(entry);
          arrived();
        } else
          response.end(
            JSON.stringify(
              name === "usage"
                ? usageResult
                : name === "capacity"
                  ? capacityReply(input)
                  : name === "computerContext"
                    ? {
                        ok: true,
                        value: {
                          accountsHref: `${parentOrigin}/org/fixture/apps/pool?view=accounts`,
                          shareHref: `${parentOrigin}/share/context-${++contextReads}`,
                        },
                      }
                    : failed,
            ),
          );
      } else if (request.url === "/") {
        response.setHeader("content-type", "text/html");
        response.end(
          `<script type="application/json" id="executor-context">{"version":"fixture"}</script>${stylesheet === null ? "" : '<link rel="stylesheet" href="/main.css">'}<div id="root"></div><script type="module" src="/main.js"></script>`,
        );
      } else response.writeHead(204).end();
    });
    servers.push(child);
    await new Promise((resolve) => child.listen(0, "127.0.0.1", resolve));
    const childAddress = child.address();
    assert.ok(childAddress && typeof childAddress !== "string");
    childOrigin = `http://127.0.0.1:${childAddress.port}`;

    // A browser server whose process this test owns by PID, reached over its local endpoint.
    browserServer = await chromium.launchServer({ headless: true });
    const browserProcess = browserServer.process();
    assert.ok(browserProcess.pid, "Browser server has no process");
    exited = new Promise((resolve) => {
      if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) resolve("exited");
      else browserProcess.once("exit", () => resolve("exited"));
    });
    browser = await chromium.connect(browserServer.wsEndpoint());

    const release = (fresh) => {
      if (fresh === undefined) {
        holdCapacity = false;
        holdPersonal = false;
        for (const entry of heldPersonal.splice(0)) entry.response.end(entry.reply);
        for (const entry of heldCapacity.splice(0))
          entry.response.end(JSON.stringify(capacityFixture(entry.input)));
      }
      const [now, later] = [[], []];
      for (const entry of held)
        (fresh === undefined || entry.fresh === fresh ? now : later).push(entry);
      held = later;
      for (const entry of now) answer(entry);
    };
    const pending = (fresh) =>
      held.filter((entry) => fresh === undefined || entry.fresh === fresh).length;
    const requests = (count, fresh) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          arrived = () => {};
          reject(
            new Error(
              `Expected ${count} held${fresh ? " fresh" : ""} view request(s), saw ${pending(fresh)}`,
            ),
          );
        }, 10_000);
        arrived = () => {
          if (pending(fresh) < count) return;
          clearTimeout(timer);
          arrived = () => {};
          resolve();
        };
        arrived();
      });
    const sent = () => ({
      retained: views.filter((view) => !view.fresh).length,
      fresh: views.filter((view) => view.fresh).length,
    });
    const capture = async (page, name) => {
      if (!artifacts) return;
      mkdirSync(artifacts, { recursive: true });
      await page.screenshot({
        path: join(artifacts, `${artifactLabel}-${name}.png`),
        fullPage: true,
      });
      if (name === "snapshot-updating") evidenceVideo = page.video();
    };
    const session = async (
      work,
      {
        clock = false,
        viewport = { width: 1100, height: 860 },
        usage = emptyUsage,
        capacityHeld = false,
        capacity = capacityFixture,
        personal = false,
        people,
      } = {},
    ) => {
      usageResult = usage;
      directoryResult = people;
      capacityReply = capacity;
      holdCapacity = capacityHeld;
      member = personal;
      heldCapacity = [];
      holdPersonal = false;
      heldPersonal = [];
      held = [];
      views = [];
      contextReads = 0;
      freshResult = undefined;
      answerFresh = false;
      const context = await browser.newContext({
        viewport,
        ...(artifacts
          ? { recordVideo: { dir: join(directory, "video"), size: { width: 1100, height: 860 } } }
          : {}),
      });
      try {
        if (clock) await context.clock.install();
        await context.route("**/*", (route) => {
          const origin = new URL(route.request().url()).origin;
          return origin === parentOrigin || origin === childOrigin
            ? route.continue()
            : route.abort();
        });
        assert.deepEqual(await context.cookies(), []);
        const page = await context.newPage();
        await page.addInitScript(instrument);
        await page.goto(parentOrigin);
        await requests(2, false); // Development StrictMode replays the real mount effect.
        const frame = page.frames().find((frame) => frame.url() === `${childOrigin}/`);
        assert.ok(frame);
        const accepted = () => page.evaluate(() => Reflect.get(window, "readiness"));
        const marks = () =>
          frame.evaluate(() =>
            performance.getEntriesByName("basalt:pool-accounts-ready").map((entry) => entry.detail),
          );
        const committedAtReady = () =>
          frame.locator("html").getAttribute("data-committed-at-ready");
        // Effects from a commit have run by the frame after it, so any extra request would have left.
        const settled = () =>
          frame.evaluate(
            () =>
              new Promise((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          );
        await work({
          page,
          frame,
          accepted,
          marks,
          committedAtReady,
          settled,
          clock: context.clock,
        });
      } finally {
        release();
        assert.deepEqual(await context.cookies(), []);
        await context.close();
      }
    };

    for (const width of [1280, 390])
      await t.test(
        `subscription overview ignores app keys and uses singular copy at ${width}px`,
        async () => {
          const now = Date.now();
          const iso = new Date(now).toISOString();
          const files = [
            { id: "claude-1", provider: "claude", label: "Review seat" },
            { id: "claude-2", provider: "claude", label: "Writing seat" },
            { id: "claude-3", provider: "claude", label: "Research seat" },
            { id: "codex-1", provider: "codex", label: "Build seat" },
            { id: "jev-key", provider: "typesafe", label: "App API key" },
          ];
          const quota = files.map(({ id, provider }) => ({
            credential: {
              credential_id: id,
              plan: { name: provider === "claude" ? "Max 20x" : "Plus" },
            },
            collection: {
              freshness: provider === "typesafe" ? "never" : "fresh",
              status: provider === "typesafe" ? "unsupported" : "success",
              observed_at: iso,
            },
            windows:
              provider === "typesafe"
                ? []
                : [18_000, 604_800].map((seconds) => ({
                    id:
                      provider === "claude"
                        ? seconds === 18_000
                          ? "claude-five-hour"
                          : "claude-seven-day"
                        : `codex-${seconds}`,
                    scope: "account",
                    window_seconds: seconds,
                    remaining_ratio: 0.8,
                    observed_at: iso,
                  })),
            reset_credits: { available_count: id === "codex-1" ? 1 : 0, credits: [] },
          }));
          const home = new PoolHome(
            new HomeClient(async (path) => {
              if (path.endsWith("/channel-groups"))
                return Response.json({
                  channel_groups: [{ id: 1, channel_name: "signalbox-pool-overview-fixture" }],
                });
              if (path.includes("/channel-group-details?"))
                return Response.json({
                  channel_group_details: files.map(({ id }, index) => ({
                    id: index + 1,
                    channel_group_id: 1,
                    auth_id: id,
                  })),
                });
              if (path.endsWith("/credentials")) return Response.json({ files });
              const detail = quota.find((row) =>
                path.endsWith(`/quota/credentials/${row.credential.credential_id}`),
              );
              if (detail) return Response.json(detail);
              throw Error("Unexpected synthetic Home request");
            }),
            "overview-fixture",
          );
          const value = await home.view(true);
          assert.equal(value.accounts.length, 5);
          assert.ok(value.accounts.some((account) => account.id === "jev-key"));
          assert.equal(value.subscriptionAccountIds.length, 4);
          if (subscriptionsBaseline)
            value.accounts = accountsView(files, quota, new Set(files.map(({ id }) => id)));
          viewResult = { ok: true, value };
          await session(
            async ({ page, frame, settled }) => {
              release();
              await frame
                .getByText(
                  `${subscriptionsBaseline ? 5 : 4} subscription accounts across ${subscriptionsBaseline ? 3 : 2} labs`,
                  { exact: true },
                )
                .waitFor();
              await frame.getByRole("heading", { name: "Needs attention", exact: true }).waitFor();
              await frame.locator("#capacity article").nth(1).waitFor();
              await settled();
              assert.equal(await frame.locator("#capacity article").count(), 2);
              const claude = frame.getByRole("article", { name: "Claude", exact: true });
              await claude.getByRole("radio", { name: "5-hour", exact: true }).click();
              await claude
                .getByRole("radio", { name: "5-hour", exact: true, checked: true })
                .waitFor();
              await claude.getByRole("radio", { name: "Weekly", exact: true }).click();
              await claude
                .getByRole("radio", { name: "Weekly", exact: true, checked: true })
                .waitFor();
              // The live case: one person with pool access. The total decides the noun.
              const noun = peopleCopyRef ? "people" : "person";
              if (!subscriptionsBaseline) {
                await frame.getByText(`1 of 1 ${noun} active`).waitFor();
                await frame.getByText(`1 of 1 ${noun} with pool access`).waitFor();
              }
              const text = await frame.locator("body").innerText();
              if (!subscriptionsBaseline) {
                assert.match(
                  text,
                  new RegExp(`(?<!\\d)1 of 1 ${noun} active · 0 requests in \\d+ days`),
                );
                assert.match(
                  text,
                  new RegExp(
                    `(?<!\\d)1 of 1 ${noun} with pool access made a request in these \\d+ days\\.`,
                  ),
                );
                if (!peopleCopyRef) assert.doesNotMatch(text, /1 of 1 people/);
              }
              for (const title of [
                "Do we have enough accounts?",
                "Who uses what",
                "API cost and subscription value",
                "Needs attention",
              ])
                assert.ok(text.includes(title), `Approved r2 section: ${title}`);
              assert.doesNotMatch(text, /This read is incomplete|Read incomplete/);
              if (!subscriptionsBaseline) {
                assert.doesNotMatch(text, /stale or missing readings|1 accounts|1 banked resets/);
                const reset = frame.getByRole("link", {
                  name: "1 banked reset available",
                  exact: true,
                });
                assert.equal(
                  await reset.getAttribute("href"),
                  `${parentOrigin}/org/fixture/apps/pool?view=accounts`,
                );
              }
              assert.ok(
                await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                "Overview fits at phone and desktop widths",
              );
              await page.locator("iframe").evaluate(
                (iframe, height) => {
                  iframe.style.height = `${height}px`;
                },
                await frame.evaluate(() => document.documentElement.scrollHeight),
              );
              await settled();
              await capture(page, `subscription-overview-${width}`);
            },
            {
              viewport: { width, height: 1000 },
              people: { members: [], activeCount: 1, totalCount: 1 },
              capacity: (input) => {
                const result = capacityFixture(input);
                const at = input.to;
                result.value.points = ["claude", "codex"].flatMap((provider) =>
                  [18_000, 604_800].map((windowSeconds) => {
                    const count = provider === "claude" ? 3 : 1;
                    const reading = {
                      remaining: 0.8 * count,
                      full: count,
                      at,
                      observedAt: { from: at, to: at },
                      accountCount: count,
                      knownWeightCount: count,
                      unknownWeightCount: 0,
                      weights: [],
                    };
                    return {
                      provider,
                      windowSeconds,
                      mode: null,
                      unit: { id: `${provider}-equivalent`, label: "account-eq" },
                      hour: Math.floor(at / hour) * hour,
                      minimum: reading,
                      last: reading,
                      plans: [],
                    };
                  }),
                );
                return result;
              },
            },
          );
          // Plural: nobody active out of three people with pool access.
          if (!subscriptionsBaseline)
            await session(
              async ({ page, frame, settled }) => {
                release();
                await frame.getByText("0 of 3 people active").waitFor();
                await frame.getByText("0 of 3 people with pool access").waitFor();
                const text = await frame.locator("body").innerText();
                assert.match(text, /(?<!\d)0 of 3 people active · 0 requests in \d+ days/);
                assert.match(
                  text,
                  /(?<!\d)0 of 3 people with pool access made a request in these \d+ days\./,
                );
                assert.doesNotMatch(text, /of 3 person/);
                assert.ok(
                  await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                  "People copy fits at phone and desktop widths",
                );
                await page.locator("iframe").evaluate(
                  (iframe, height) => {
                    iframe.style.height = `${height}px`;
                  },
                  await frame.evaluate(() => document.documentElement.scrollHeight),
                );
                await settled();
                await capture(page, `people-plural-overview-${width}`);
              },
              {
                viewport: { width, height: 1000 },
                people: { members: [], activeCount: 0, totalCount: 3 },
              },
            );
        },
      );

    for (const width of [1440, 390])
      await t.test(`usage loads while capacity is held at ${width}px`, async () => {
        // A current Codex account, so the held capacity reading becomes a real lab verdict.
        const codexSeat = poolView(Date.now(), {
          source: "live",
          observedAgo: minute,
          savedAgo: minute,
          left: [
            [0.5, 0.8],
            [0.5, 0.8],
            [0.5, 0.8],
          ],
        }).value.accounts[0];
        viewResult = { ok: true, value: { ...empty, providers, accounts: [codexSeat] } };
        const total = {
          ...emptyUsage.value.total,
          requests: 1,
          cost: 0.02,
          tokens: { ...emptyUsage.value.total.tokens, input: 100, output: 28, total: 128 },
        };
        const populatedUsage = {
          ok: true,
          value: {
            ...emptyUsage.value,
            total,
            models: [{ ...total, provider: "codex", model: "Synthetic model" }],
            accountsNeeded: [
              {
                provider: "codex",
                advice: "enough",
                accounts: 1,
                limitHits: 0,
                exhausted: 0,
                hoursRead: 24,
              },
            ],
          },
        };
        await session(
          async ({ page, frame, accepted, settled }) => {
            await settled();
            await capture(page, `usage-before-capacity-${width}`);
            const queries = await frame.evaluate(() => Reflect.get(window, "queries"));
            assert.ok(
              queries.includes("overviewUsage"),
              "Usage must start before the held capacity read answers",
            );
            await frame.waitForFunction(
              () =>
                Reflect.get(window, "completedQueries").filter((name) => name === "overviewUsage")
                  .length >= 2,
            );
            await settled();
            await capture(page, `usage-awaits-provider-names-${width}`);
            const who = frame.locator("#who");
            const money = frame.locator("#cost");
            assert.ok(heldCapacity.length > 0, "Every capacity response stays held");
            assert.deepEqual(
              await Promise.all([
                frame.getByRole("heading", { name: "Who uses what", exact: true }).isVisible(),
                money.getByText("API cost", { exact: true }).isVisible(),
                money
                  .getByText(/^\$0\.02/)
                  .first()
                  .isVisible(),
                who
                  .getByText(/128 tokens/)
                  .first()
                  .isVisible(),
                who
                  .getByText(/1 requests?/)
                  .first()
                  .isVisible(),
              ]),
              [true, true, true, true, true],
              "The completed usage response must be visible while every capacity response is held",
            );
            await frame.getByRole("radio", { name: "Models", exact: true }).click();
            await frame
              .getByRole("radio", { name: "Models", exact: true, checked: true })
              .waitFor();
            await who.getByText("Synthetic model", { exact: true }).waitFor();
            assert.equal(await who.getByText("Synthetic model", { exact: true }).isVisible(), true);
            if (width === 390) {
              // Phones keep the mock's columns; the range total above the table carries tokens.
              assert.match(await who.innerText(), /128 tokens · 1 request in 7 days/);
            } else {
              assert.equal(
                await who.locator('table [title="128 tokens"]').first().isVisible(),
                true,
              );
            }
            assert.equal(
              await frame.getByText("codex", { exact: true }).count(),
              0,
              "Provider IDs must not flash before the pool view supplies their names",
            );
            assert.equal(
              await frame.getByText("Codex", { exact: true }).count(),
              0,
              "Usage must not guess provider names before capacity supplies them",
            );
            assert.doesNotMatch(await frame.locator("body").innerText(), /\b(?:codex|Codex)\b/);
            assert.equal(
              await frame.getByRole("list", { name: "Accounts needed", exact: true }).count(),
              0,
              "Account advice waits for provider names instead of naming raw IDs",
            );
            assert.deepEqual(await accepted(), [], "Usage does not claim accounts are ready");
            const usageReads = await frame.evaluate(
              () =>
                Reflect.get(window, "queries").filter((name) => name === "overviewUsage").length,
            );
            holdCapacity = false;
            for (const entry of heldCapacity.splice(0)) {
              const capacity = capacityFixture(entry.input);
              const at = entry.input.to;
              const reading = {
                remaining: 8,
                full: 10,
                at,
                observedAt: { from: at, to: at },
                accountCount: 1,
                knownWeightCount: 1,
                unknownWeightCount: 0,
                weights: [],
              };
              capacity.value.points.push({
                provider: "codex",
                windowSeconds: 604_800,
                mode: null,
                unit: { id: "quota", label: "quota" },
                hour: Math.floor(at / hour) * hour,
                minimum: reading,
                last: reading,
                plans: [],
              });
              entry.response.end(JSON.stringify(capacity));
            }
            await frame.waitForFunction(
              () =>
                Reflect.get(window, "completedQueries").filter((name) => name === "capacity")
                  .length >= 2,
            );
            await settled();
            assert.match(
              await frame.getByRole("link", { name: /Enough accounts\?/ }).innerText(),
              /Reading/,
              "Capacity advice waits for provider names even after capacity answers",
            );
            assert.deepEqual(await accepted(), [], "Capacity alone does not report accounts ready");
            release();
            await frame.getByText("1 subscription account across 1 lab", { exact: true }).waitFor();
            await frame.getByRole("radio", { name: "Models", exact: true }).click();
            await frame
              .getByRole("radio", { name: "Models", exact: true, checked: true })
              .waitFor();
            await frame.getByText("Synthetic model", { exact: true }).waitFor();
            await frame.getByText("Codex", { exact: true }).first().waitFor();
            await frame
              .getByRole("link", { name: /Enough accounts\?/ })
              .getByText(/^Codex:/)
              .waitFor();
            assert.deepEqual(
              await who.evaluate((section) => {
                const table = section.querySelector("table").getBoundingClientRect();
                return [table.right <= section.getBoundingClientRect().right + 0.5];
              }),
              [true],
              `The usage table stays inside the content column at ${width}px`,
            );
            assert.deepEqual(
              await who
                .locator("thead th")
                .evaluateAll((cells) => cells.map((cell) => cell.textContent.trim())),
              ["Model", "Tokens by lab", "Requests", "Tokens", "Subscription value", "API cost"],
            );
            await capture(page, `usage-ready-${width}`);
            await settled();
            const after = await frame.evaluate(() => Reflect.get(window, "queries"));
            assert.equal(
              after.filter((name) => name === "overviewUsage").length,
              usageReads,
              "Receiving capacity must not fetch usage again",
            );
          },
          { viewport: { width, height: 860 }, usage: populatedUsage, capacityHeld: true },
        );
      });
    for (const width of [1440, 390])
      await t.test(
        `usage failure and retry stay usable without capacity at ${width}px`,
        async () => {
          viewResult = { ok: true, value: { ...empty, providers } };
          await session(
            async ({ frame, settled, accepted }) => {
              await frame.waitForFunction(
                () =>
                  Reflect.get(window, "completedQueries").filter((name) => name === "overviewUsage")
                    .length >= 2,
              );
              await settled();
              const who = frame.locator("#who");
              assert.ok(heldCapacity.length > 0);
              assert.equal(
                await who
                  .getByText("Overview could not be read. Reload and try again.", { exact: true })
                  .isVisible(),
                true,
              );
              assert.equal(
                await who.getByRole("button", { name: "Try again", exact: true }).isEnabled(),
                true,
              );
              const before = await frame.evaluate(
                () =>
                  Reflect.get(window, "queries").filter((name) => name === "overviewUsage").length,
              );
              usageResult = emptyUsage;
              await who.getByRole("button", { name: "Try again", exact: true }).click();
              await who
                .getByText("No requests through this pool in the last 7 days.", { exact: true })
                .waitFor();
              assert.equal(
                await who
                  .getByText("Overview could not be read. Reload and try again.", { exact: true })
                  .count(),
                0,
              );
              assert.equal(
                await frame.getByRole("list", { name: "Accounts needed", exact: true }).count(),
                0,
              );
              const after = await frame.evaluate(
                () =>
                  Reflect.get(window, "queries").filter((name) => name === "overviewUsage").length,
              );
              assert.equal(
                after,
                before + 1,
                "Retry sends one usage read without waiting for capacity",
              );
              assert.deepEqual(
                await accepted(),
                [],
                "Usage recovery does not claim capacity is ready",
              );
            },
            { viewport: { width, height: 860 }, usage: failed, capacityHeld: true },
          );
        },
      );
    for (const width of [1440, 390])
      await t.test(
        `member usage renders only the caller while capacity is held at ${width}px`,
        async () => {
          viewResult = { ok: true, value: { ...empty, providers, isOwner: false } };
          const total = {
            ...emptyUsage.value.total,
            requests: 1,
            cost: 0.02,
            tokens: { ...emptyUsage.value.total.tokens, input: 100, output: 28, total: 128 },
          };
          const usage = {
            ok: true,
            value: {
              ...emptyUsage.value,
              scope: "you",
              total,
              models: [{ ...total, provider: "codex", model: "Synthetic model" }],
            },
          };
          await session(
            async ({ frame, settled, accepted }) => {
              await frame.waitForFunction(() =>
                Reflect.get(window, "completedQueries").includes("personalOverview"),
              );
              await settled();
              const who = frame.locator("#who");
              assert.ok(heldCapacity.length > 0);
              assert.equal(
                await who
                  .getByText(
                    "Your requests through this pool in the last 7 days. Nobody else's show here.",
                    { exact: true },
                  )
                  .isVisible(),
                true,
              );
              assert.equal(
                await who
                  .getByText(/128 tokens/)
                  .first()
                  .isVisible(),
                true,
              );
              await who.getByRole("button", { name: "You", exact: true }).click();
              await who
                .getByText(/^Synthetic model/)
                .first()
                .waitFor();
              assert.equal(
                await who
                  .getByText(/^Synthetic model/)
                  .first()
                  .isVisible(),
                true,
              );
              assert.equal(
                await frame.getByRole("navigation", { name: "At a glance", exact: true }).count(),
                0,
              );
              assert.equal(
                await frame.getByRole("radio", { name: "Models", exact: true }).count(),
                0,
              );
              assert.equal(await frame.getByText("codex", { exact: true }).count(), 0);
              assert.equal(await frame.getByText("Codex", { exact: true }).count(), 0);
              assert.doesNotMatch(await frame.locator("body").innerText(), /\b(?:codex|Codex)\b/);
              assert.deepEqual(await accepted(), []);
              const reads = await frame.evaluate(
                () =>
                  Reflect.get(window, "queries").filter((name) => name === "personalOverview")
                    .length,
              );
              release();
              await who.getByText(/Codex/).first().waitFor();
              await settled();
              assert.equal(
                await frame.evaluate(
                  () =>
                    Reflect.get(window, "queries").filter((name) => name === "personalOverview")
                      .length,
                ),
                reads,
                "Capacity only fills labels; it never re-reads personal usage",
              );
            },
            { viewport: { width, height: 860 }, usage, capacityHeld: true, personal: true },
          );
        },
      );
    for (const width of [1440, 390])
      await t.test(
        `personal usage retries to a caller-scoped empty result at ${width}px`,
        async () => {
          viewResult = { ok: true, value: { ...empty, providers, isOwner: false } };
          await session(
            async ({ frame, accepted, settled }) => {
              const failure = frame.getByText(
                "Your usage could not be read. Reload and try again.",
                { exact: true },
              );
              await failure.waitFor();
              assert.ok(heldCapacity.length > 0);
              assert.equal(
                await frame.getByRole("button", { name: "Try again", exact: true }).isEnabled(),
                true,
              );
              const before = await frame.evaluate(
                () =>
                  Reflect.get(window, "queries").filter((name) => name === "personalOverview")
                    .length,
              );
              usageResult = { ok: true, value: { ...emptyUsage.value, scope: "you" } };
              await frame.getByRole("button", { name: "Try again", exact: true }).click();
              const who = frame.locator("#who");
              await who.getByText("No requests in this range", { exact: true }).waitFor();
              assert.equal(
                await who
                  .getByText(
                    "Your requests through this pool in the last 7 days. Nobody else's show here.",
                    { exact: true },
                  )
                  .isVisible(),
                true,
              );
              assert.equal(await who.getByText("You", { exact: true }).isVisible(), true);
              assert.equal(await failure.count(), 0);
              assert.equal(
                await frame.getByRole("navigation", { name: "At a glance", exact: true }).count(),
                0,
              );
              assert.equal(
                await frame.getByRole("radio", { name: "Models", exact: true }).count(),
                0,
              );
              assert.equal(
                await frame.getByRole("list", { name: "Accounts needed", exact: true }).count(),
                0,
              );
              await settled();
              assert.equal(
                await frame.evaluate(
                  () =>
                    Reflect.get(window, "queries").filter((name) => name === "personalOverview")
                      .length,
                ),
                before + 1,
                "Retry sends one caller-scoped usage read without capacity",
              );
              assert.ok(heldCapacity.length > 0);
              assert.deepEqual(
                await accepted(),
                [],
                "Personal recovery never claims accounts are ready",
              );
            },
            { viewport: { width, height: 860 }, usage: failed, capacityHeld: true, personal: true },
          );
        },
      );
    await t.test(
      "overview range and authorization changes cannot reuse mismatched pieces",
      async () => {
        viewResult = { ok: true, value: { ...empty, providers } };
        const total = {
          ...emptyUsage.value.total,
          requests: 1,
          cost: 0.02,
          tokens: { ...emptyUsage.value.total.tokens, total: 128 },
        };
        const usage = {
          ok: true,
          value: {
            ...emptyUsage.value,
            total,
            models: [{ ...total, provider: "codex", model: "Synthetic model" }],
          },
        };
        await session(
          async ({ frame, settled, clock }) => {
            const who = frame.locator("#who");
            await who
              .getByText(/128 tokens/)
              .first()
              .waitFor();
            const enough = frame.getByRole("link", { name: /Enough accounts\?/ });
            assert.match(await enough.textContent(), /Reading/);
            await frame.getByRole("radio", { name: "30 days", exact: true }).click();
            await who.getByText(/1 request in 30 days/).waitFor();
            const old = heldCapacity.filter((entry) => entry.input.days === 7);
            assert.ok(old.length > 0, "The previous range has real capacity reads in flight");
            heldCapacity = heldCapacity.filter((entry) => entry.input.days !== 7);
            for (const entry of old)
              entry.response.end(JSON.stringify(capacityFixture(entry.input)));
            await settled();
            assert.match(
              await enough.textContent(),
              /Reading/,
              "Old-range capacity never completes the new overview",
            );
            release();
            await frame.getByText("Pick your first account", { exact: true }).waitFor();
            // The pool has no accounts, so any reading it still has is not current capacity.
            await enough.getByText("No accounts yet", { exact: true }).waitFor();
            assert.equal(
              await frame.locator("#capacity article").count(),
              0,
              "A lab with no current account shows no capacity panel",
            );
            assert.match(
              await frame.locator("#capacity").innerText(),
              /No accounts in this pool, so there is no capacity to show/,
            );
            assert.equal(
              await frame.getByText(/This read is incomplete/).count(),
              0,
              "Only a same-range pair can claim coherence",
            );
            // Ordinary view polls must answer: held polls would exhaust the browser's HTTP slots.
            answerFresh = true;
            usageResult = failed;
            holdCapacity = true;
            await clock.runFor(5 * 60_000 + 50);
            await who
              .getByText("Overview could not be read. Reload and try again.", { exact: true })
              .waitFor();
            assert.ok(
              heldCapacity.length > 0,
              "A new usage error cannot wait for refreshed capacity",
            );
            usageResult = usage;
            await who.getByRole("button", { name: "Try again", exact: true }).click();
            await who.getByText(/1 request in 30 days/).waitFor();
            member = true;
            holdPersonal = true;
            await clock.runFor(5 * 60_000 + 50);
            await frame
              .getByText(
                "Shared with you. You use its accounts without seeing their credentials.",
                { exact: true },
              )
              .waitFor();
            assert.ok(
              heldPersonal.length > 0,
              "Personal usage stays held after the manager endpoint denies access",
            );
            assert.equal(
              await frame.getByRole("navigation", { name: "At a glance", exact: true }).count(),
              0,
              "The old manager snapshot disappears as soon as authorization changes",
            );
            holdPersonal = false;
            for (const entry of heldPersonal.splice(0)) entry.response.end(entry.reply);
            await who
              .getByText(
                "Your requests through this pool in the last 30 days. Nobody else's show here.",
                { exact: true },
              )
              .waitFor();
          },
          { viewport: { width: 390, height: 860 }, usage, capacityHeld: true, clock: true },
        );
      },
    );
    for (const width of sourceRef ? [] : [1440, 390])
      await t.test(
        `hidden pool links stop refreshing and resume once overdue at ${width}px`,
        async () => {
          viewResult = { ok: true, value: empty };
          await session(
            async ({ page, frame, clock }) => {
              answerFresh = true;
              release();
              const share = frame.getByRole("link", { name: "Share", exact: true });
              await share.waitFor();
              const initial = contextReads;
              assert.equal(initial, 2, "StrictMode's initial context reads have completed");
              const quiet = async (expected, message) => {
                await page.evaluate(
                  () =>
                    new Promise((resolve) =>
                      requestAnimationFrame(() => requestAnimationFrame(resolve)),
                    ),
                );
                await frame.evaluate(() =>
                  fetch("/_fixture/sentinel").then((response) => response.arrayBuffer()),
                );
                assert.equal(
                  await frame.evaluate(() => Reflect.get(window, "contextSends")),
                  expected,
                  message,
                );
                assert.equal(contextReads, expected, message);
              };
              const host = async (active) => {
                await frame.evaluate(() => {
                  Reflect.set(window, "hostActiveSeen", undefined);
                  addEventListener(
                    "message",
                    (event) => {
                      if (event.source === parent && event.data?.type === "executor:app-active")
                        Reflect.set(window, "hostActiveSeen", event.data.active);
                    },
                    { once: true },
                  );
                });
                await page.evaluate(
                  ({ active, origin }) => {
                    const element = document.querySelector("iframe");
                    element.style.display = active ? "block" : "none";
                    element.contentWindow.postMessage(
                      { type: "executor:app-active", active },
                      origin,
                    );
                  },
                  { active, origin: childOrigin },
                );
                await frame.waitForFunction(
                  (active) => Reflect.get(window, "hostActiveSeen") === active,
                  active,
                );
              };
              await host(false);
              await clock.runFor(9 * minute);
              await quiet(initial, "A retained hidden pool makes no context reads");
              await host(true);
              await share
                .and(frame.locator(`[href="${parentOrigin}/share/context-${initial + 1}"]`))
                .waitFor();
              assert.equal(
                contextReads,
                initial + 1,
                "An overdue return renews its link exactly once",
              );
              await frame.evaluate(() => {
                Object.defineProperty(document, "visibilityState", {
                  configurable: true,
                  value: "hidden",
                });
                document.dispatchEvent(new Event("visibilitychange"));
              });
              await clock.runFor(9 * minute);
              await quiet(initial + 1, "A hidden browser tab makes no context reads");
              await frame.evaluate(() => {
                Object.defineProperty(document, "visibilityState", {
                  configurable: true,
                  value: "visible",
                });
                document.dispatchEvent(new Event("visibilitychange"));
              });
              await share
                .and(frame.locator(`[href="${parentOrigin}/share/context-${initial + 2}"]`))
                .waitFor();
              assert.equal(
                contextReads,
                initial + 2,
                "A visible tab renews its overdue link exactly once",
              );
              await host(false);
              await clock.runFor(minute);
              await host(true);
              await quiet(initial + 2, "A short hidden interval keeps the current link");
            },
            { clock: true, viewport: { width, height: 960 } },
          );
        },
      );

    for (const { populated, recovery, sourced } of sourceRef
      ? []
      : [
          { populated: false },
          { populated: true },
          { populated: true, sourced: true },
          { populated: true, recovery: "manual" },
          { populated: true, recovery: "background" },
        ])
      await t.test(
        recovery
          ? `failed first load, then ${recovery} recovery`
          : sourced
            ? "explicit live capacity"
            : populated
              ? "capacity readings"
              : "authorized empty result",
        async () => {
          const value = populated
            ? {
                ...empty,
                accounts: [
                  {
                    id: "fixture-account",
                    provider: "fixture",
                    label: "Synthetic subscription",
                    plan: null,
                    state: "active",
                    message: null,
                    windows: [],
                    observedAt: null,
                    freshness: "never",
                    readingFailed: false,
                    nextReadAt: null,
                    earliestResetAt: null,
                    bankedResets: null,
                  },
                ],
              }
            : empty;
          if (sourced)
            value.reading = poolView(Date.now(), {
              source: "live",
              observedAgo: 0,
              savedAgo: 0,
              left: [
                [1, 1],
                [1, 1],
                [1, 1],
              ],
            }).value.reading;
          viewResult = recovery ? failed : { ok: true, value };
          await session(async ({ page, frame, accepted, marks, committedAtReady }) => {
            const poll = async () => {
              await frame.evaluate(() => {
                const now = Date.now();
                Date.now = () => now + 60_001;
              });
              await page.evaluate((origin) => {
                const frame = document.querySelector("iframe");
                frame.contentWindow.postMessage(
                  { type: "executor:app-active", active: false },
                  origin,
                );
                frame.contentWindow.postMessage(
                  { type: "executor:app-active", active: true },
                  origin,
                );
              }, childOrigin);
            };
            assert.deepEqual(await accepted(), []);
            release();
            const visible = populated
              ? "1 subscription account across 1 lab"
              : "Pick your first account";
            if (recovery) {
              await frame.getByText("Synthetic pool failure", { exact: true }).waitFor();
              assert.deepEqual(await marks(), []);
              assert.doesNotMatch(await frame.locator("body").innerText(), /\b(?:codex|Codex)\b/);
              assert.deepEqual(await accepted(), []);
              viewResult = { ok: true, value };
              if (recovery === "manual")
                await frame
                  .getByRole("alert")
                  .filter({ hasText: "Synthetic pool failure" })
                  .locator("..")
                  .getByRole("button", { name: "Try again", exact: true })
                  .click();
              else await poll();
              await requests(1, true);
              release();
              await frame.getByText(visible, { exact: true }).waitFor();
              assert.deepEqual(await marks(), []);
              assert.doesNotMatch(await frame.locator("body").innerText(), /\b(?:codex|Codex)\b/);
              assert.deepEqual(await accepted(), []);
              return;
            }
            await frame.getByText(visible, { exact: true }).waitFor();
            assert.equal(
              await frame.getByRole("link", { name: "Accounts", exact: true }).getAttribute("href"),
              `${parentOrigin}/org/fixture/apps/pool?view=accounts`,
            );
            assert.equal(
              await frame.getByRole("list", { name: "Accounts", exact: true }).count(),
              0,
            );
            assert.equal(
              await frame.getByText("Synthetic subscription", { exact: true }).count(),
              0,
            );
            await page.waitForFunction(
              () => Reflect.get(window, "readiness").length + Reflect.get(window, "rejected") > 0,
            );
            assert.deepEqual(
              (await accepted()).map((entry) => entry.data),
              [ready],
            );
            assert.ok((await committedAtReady())?.includes(visible));
            // A view from a pool without retained views is live.
            assert.deepEqual(await marks(), [{ source: "live" }]);
            assert.deepEqual(sent(), { retained: 2, fresh: 0 });
            // Unrelated sources and unsupported contracts cannot satisfy the parent probe.
            await page.evaluate((data) => window.postMessage(data, location.origin), ready);
            const invalid = [
              { name: ready.name, version: 1 },
              { ...ready, version: 3 },
              { name: ready.name, version: 2 },
              { ...ready, snapshot: "snapshot" },
              { ...ready, snapshot: 0 },
              { ...ready, snapshot: null },
              { ...ready, extra: true },
            ];
            await frame.evaluate(
              ({ origin, messages }) => {
                for (const data of messages) window.parent.postMessage(data, origin);
              },
              { origin: parentOrigin, messages: invalid },
            );
            await page.waitForFunction(
              (count) => Reflect.get(window, "rejected") === count,
              invalid.length + 1,
            );
            assert.equal((await accepted()).length, 1);
            await poll();
            await requests(1, true);
            viewResult = { ok: true, value: empty };
            release();
            await frame.getByText("Pick your first account", { exact: true }).waitFor();
            assert.equal((await marks()).length, 1);
            assert.equal((await accepted()).length, 1);
            // Keep the same WindowProxy, changing only its actual origin.
            await frame.goto(`${parentOrigin}/spoof`);
            await page.waitForFunction(
              (count) => Reflect.get(window, "rejected") === count,
              invalid.length + 2,
            );
            assert.equal((await accepted()).length, 1);
          });
        },
      );

    const retained = () =>
      poolView(Date.now(), {
        source: "snapshot",
        observedAgo: 18 * minute,
        savedAgo: 6 * minute,
        left: [
          [0.42, 0.71],
          [0.08, 0.33],
          [0.9, 0.64],
        ],
      });
    const live = () =>
      poolView(Date.now(), {
        source: "live",
        observedAgo: 20_000,
        savedAgo: 2_000,
        left: [
          [0.37, 0.69],
          [0.55, 0.31],
          [0.88, 0.63],
        ],
      });
    const saved = sourceRef ? "build-seat-1@example.com" : "3 subscription accounts across 2 labs";
    /** The retained view is on screen, measured once as a snapshot, and exactly one fresh read followed its commit. */
    const retainedCommitted = async ({ page, frame, accepted, marks, committedAtReady }, name) => {
      release(false);
      await frame.getByText(saved, { exact: true }).waitFor();
      await capture(page, name);
      await page.waitForFunction(
        () => Reflect.get(window, "readiness").length + Reflect.get(window, "rejected") > 0,
      );
      assert.deepEqual(
        (await accepted()).map((entry) => entry.data),
        [{ ...ready, snapshot: true }],
      );
      assert.deepEqual(await marks(), [{ source: "snapshot" }]);
      assert.ok((await committedAtReady())?.includes(saved));
      await frame.waitForFunction(() => Reflect.get(window, "followUps").length === 1);
      const [shown] = await frame.evaluate(() => Reflect.get(window, "followUps"));
      assert.ok(
        shown.includes(saved),
        "The fresh follow-up left before the retained view committed",
      );
      assert.ok(shown.includes("Saved view, updating…"));
    };
    const once = async ({ marks, accepted }) => {
      assert.deepEqual(await marks(), [{ source: "snapshot" }]);
      assert.equal((await accepted()).length, 1);
    };

    await t.test(
      "a retained view commits first, then one fresh follow-up replaces it",
      async () => {
        viewResult = retained();
        await session(async (probe) => {
          const { page, frame, settled } = probe;
          await retainedCommitted(probe, "snapshot-updating");
          await requests(1, true);
          await frame.getByText("Saved view, updating…", { exact: true }).waitFor();
          freshResult = live();
          release(true);
          await frame.getByText("Usage read just now", { exact: true }).waitFor();
          assert.equal(await frame.getByText("Saved view", { exact: false }).count(), 0);
          await capture(page, "live");
          await settled();
          assert.deepEqual(sent(), { retained: 2, fresh: 1 });
          await once(probe);
        });
      },
    );

    await t.test(
      "a follow-up answered at once still lands after the retained commit",
      { skip: Boolean(sourceRef) },
      async () => {
        viewResult = retained();
        await session(async (probe) => {
          const { frame, settled } = probe;
          freshResult = live();
          answerFresh = true;
          await retainedCommitted(probe, "snapshot-immediate");
          await frame.getByText("Usage read just now", { exact: true }).waitFor();
          await settled();
          assert.deepEqual(sent(), { retained: 2, fresh: 1 });
          await once(probe);
        });
      },
    );

    await t.test(
      "failed revalidation keeps the retained view, says so, and retries fresh only when asked",
      { skip: Boolean(sourceRef) },
      async () => {
        viewResult = retained();
        await session(async (probe) => {
          const { page, frame, settled } = probe;
          await retainedCommitted(probe, "snapshot-before-failure");
          await requests(1, true);
          freshResult = {
            ...viewResult,
            value: {
              ...viewResult.value,
              reading: { ...viewResult.value.reading, revalidationFailed: true },
            },
          };
          release(true);
          await frame.getByText(/^Couldn't update; showing a saved view from 6m ago$/).waitFor();
          await frame.getByText(saved, { exact: true }).waitFor();
          await capture(page, "revalidation-failed");
          await settled();
          // A failed revalidation is an answer, not a reason to ask again.
          assert.deepEqual(sent(), { retained: 2, fresh: 1 });
          await frame
            .getByText(/^Couldn't update; showing a saved view from 6m ago$/)
            .locator("..")
            .getByRole("button", { name: "Try again", exact: true })
            .click();
          await requests(1, true);
          assert.deepEqual(sent(), { retained: 2, fresh: 2 });
          freshResult = live();
          release(true);
          await frame.getByText("Usage read just now", { exact: true }).waitFor();
          await settled();
          assert.deepEqual(sent(), { retained: 2, fresh: 2 });
          await once(probe);
        });
      },
    );

    await t.test(
      "an unreachable follow-up keeps the retained view and its error",
      { skip: Boolean(sourceRef) },
      async () => {
        viewResult = retained();
        await session(async (probe) => {
          const { page, frame, settled } = probe;
          await retainedCommitted(probe, "snapshot-before-unreachable");
          await requests(1, true);
          freshResult = failed;
          release(true);
          await frame.getByText("Synthetic pool failure", { exact: true }).waitFor();
          await frame.getByText(saved, { exact: true }).waitFor();
          await frame.getByText(/^Showing a saved view from 6m ago$/).waitFor();
          await capture(page, "follow-up-unreachable");
          await settled();
          assert.deepEqual(sent(), { retained: 2, fresh: 1 });
          await frame
            .getByRole("alert")
            .filter({ hasText: "Synthetic pool failure" })
            .locator("..")
            .getByRole("button", { name: "Try again", exact: true })
            .click();
          await requests(1, true);
          freshResult = live();
          release(true);
          await frame.getByText("Usage read just now", { exact: true }).waitFor();
          assert.equal(await frame.getByText("Synthetic pool failure", { exact: true }).count(), 0);
          assert.deepEqual(sent(), { retained: 2, fresh: 2 });
          await once(probe);
        });
      },
    );

    await t.test("the sender targets the exact configured parent origin", async () => {
      viewResult = { ok: true, value: empty };
      held = [];
      views = [];
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        // The external parent is a spy only for this argument-level assertion.
        await page.addInitScript(() => {
          Object.defineProperty(window, "parent", {
            value: {
              postMessage(data, targetOrigin) {
                if (data?.name === "basalt:pool-accounts-ready")
                  Reflect.set(window, "sentReady", { data, targetOrigin });
              },
            },
          });
        });
        await page.goto(childOrigin);
        await requests(2, false);
        release();
        await page
          .getByText(sourceRef ? "No accounts yet." : "Pick your first account", { exact: true })
          .waitFor();
        assert.deepEqual(await page.evaluate(() => Reflect.get(window, "sentReady")), {
          data: ready,
          targetOrigin: parentOrigin,
        });
      } finally {
        release();
        await context.close();
      }
    });
  },
);

/** The pool stylesheet with the utilities the built bundle uses, as scripts/setup-build.ts builds it. */
async function compileStyles(app, javascript) {
  const { build } = require("esbuild");
  const styles = await build({
    entryPoints: [join(app, "ui/style.css")],
    write: false,
    bundle: true,
    outfile: "main.css",
    alias: { tailwindcss: join(root, ".upstream/packages/ui/node_modules/tailwindcss/index.css") },
  });
  const { compile } = createRequire(join(root, ".upstream/packages/sdk/package.json"))(
    "tailwindcss",
  );
  const vite = createRequire(
    realpathSync(
      join(root, ".upstream/apps/hosted/web/node_modules/@tailwindcss/vite/package.json"),
    ),
  );
  const { Scanner } = vite("@tailwindcss/oxide");
  const candidates = new Scanner({ sources: [] }).scanFiles([
    { content: javascript, extension: "js" },
  ]);
  return (await compile(styles.outputFiles[0].text)).build(candidates);
}
