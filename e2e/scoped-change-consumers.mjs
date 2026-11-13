// Run only through the parent's managed proof slot. This starts the full Cloud harness;
// it never substitutes an HTML page, an API response, or a fabricated change event.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { Effect, Redacted } from "effect";
import { root, runtime, until } from "./recipes/harness.mjs";
import { poolCloudHarness } from "./recipes/pool-cloud-harness.mjs";
import { startScopedChangeFixture } from "./recipes/scoped-change-fixture.mjs";
import { cloudLocks } from "../.upstream/e2e/support/cloud-locks.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";
import { roleHost } from "../.upstream/e2e/support/role-hosts.ts";
import {
  batchedReads,
  batchPath,
  splitRoutedReads,
} from "../.upstream/e2e/support/read-batches.ts";
import { redactLogText } from "../src/feedback/logs.ts";

const { chromium } = createRequire(join(root, ".upstream/package.json"))("playwright");
const args = process.argv.slice(2);
const accountsOnly = args.includes("--accounts-only");
const directory = resolve(
  args.find((arg) => !arg.startsWith("--")) ??
    join(root, ".generated/scoped-change-consumers", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(join(root, ".upstream"));
const checks = [],
  screenshots = [];
const diagnostics = { pool: { proved: false } };
const check = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
const browserWork = (work) => Effect.promise(work).pipe(Effect.timeout("30 seconds"));
const resources = (url) => /^\/api\/organizations\/[^/]+\/resources\/accounts$/.test(url.pathname);
const accountReads = (request) => {
  const path = new URL(request.url()).pathname;
  if (request.method() === "GET" && resources(new URL(request.url()))) return 1;
  if (request.method() === "POST" && path === batchPath)
    return batchedReads(request.postData()).filter(
      (read) => read.group === "resourceAccess" && read.endpoint === "accounts",
    ).length;
  return 0;
};

const program = Effect.gen(function* () {
  const h = yield* poolCloudHarness(directory, {
    resets: true,
    fixtureFactory: startScopedChangeFixture,
  });
  const browserOrigin = roleHost(h.origin, "app");
  diagnostics.runtimeDirectory = h.runtimeDirectory;
  diagnostics.fixtureFailures = h.fixture.scoped.failures;
  const identity = yield* h.request("GET", "/api/auth/get-session");
  const pool = yield* until(
    h.request("GET", `${h.prefix}/apps`),
    (apps) => apps.some((app) => app.name === `${identity.user.name}'s pool`),
    "native pool provisioning did not finish",
  ).pipe(Effect.map((apps) => apps.find((app) => app.name === `${identity.user.name}'s pool`)));
  yield* until(
    h.request("GET", `${h.appPath(pool.id)}/accounts/app`),
    (links) => links.some((link) => link.requirement === "pool" && link.hostManaged),
    "native pool access was not linked",
  );
  const provider = yield* h.request("POST", `${h.prefix}/apps/install`, {
    entry: "provider-openai",
    name: "Synthetic scoped-change provider",
  });
  h.fixture.prepareAcquisition(null, "synthetic-scoped-change-codex", "codex", 2);
  const pending = yield* h.request(
    "POST",
    `${h.appPath(provider.id)}/accounts/app/openai/connections`,
    {
      destination: { kind: "shared", audience: { kind: "everyone" } },
    },
  );
  const connection = `${h.prefix}/connections/${pending.id}/interactive`;
  yield* h.request("POST", `${connection}/start`, { method: "codex" });
  const saved = yield* h.request("GET", `${connection}/status`);
  check("account saved through the actual hosted provider connection", saved.state, "connected");
  yield* h.request("PUT", `${h.appPath(pool.id)}/accounts/app/openai/${saved.account.id}`);
  const account = `${h.prefix}/accounts/${saved.account.id}`;
  let label = "Synthetic scoped account";
  yield* h.request("PATCH", account, { label });
  yield* h.request("POST", `${account}/observations/refresh`);
  yield* until(
    h.request("GET", `${h.prefix}/resources/accounts`),
    (rows) => rows.some((row) => row.id === saved.account.id),
    "saved account projection unavailable",
  );

  // cloudLocks' supported fixture uses only Target.directory to reach this managed database.
  const database = yield* cloudLocks.pipe(
    Effect.provideService(Target, { directory: h.runtimeDirectory }),
  );
  const scope = `organization:${h.actors.organization.id}`;
  const head = () =>
    database
      .run({
        sql: "select revision::text from hosted_change_heads where scope=$1 and topic='accounts' and resource='*'",
        params: [scope],
      })
      .pipe(Effect.map((rows) => rows[0]?.revision ?? "0"));
  const outboxEmpty = () =>
    database.run({
      sql: `select count(p.*)::text as count, max(p.revision)::text as revision,
        max(p.updated_at)::text as updated_at,
        (select revision::text from hosted_change_heads where scope=$1 and topic='accounts' and resource='*') as head
        from hosted_change_pending p where scope=$1 and topic='accounts' and resource='*'`,
      params: [scope],
    });
  // A pass can precede a provisioning tail. Each bounded retry drives the public delivery path.
  const barrier = () => {
    const progress = { attempts: 0, last: undefined };
    diagnostics.changeBarrier = progress;
    return until(
      Effect.gen(function* () {
        progress.attempts++;
        yield* h.request("PATCH", account, { label });
        const rows = yield* outboxEmpty();
        progress.last = rows[0];
        return rows;
      }),
      (rows) => rows[0]?.count === "0",
      "change outbox did not drain",
    ).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail("change outbox did not drain"),
      }),
    );
  };
  yield* barrier();
  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch({ headless: true })),
    (browser) => Effect.promise(() => browser.close()),
  );

  for (const width of [1280, 390]) {
    const context = yield* Effect.acquireRelease(
      Effect.promise(() =>
        browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true }),
      ),
      (context) => Effect.promise(() => context.close()),
    );
    const cookies = Redacted.value(yield* h.actors.owner.cookies);
    yield* browserWork(() => context.addCookies([...cookies]));
    yield* browserWork(() =>
      context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        const local =
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
          url.hostname.endsWith(".localhost");
        return !["http:", "https:"].includes(url.protocol) || local
          ? route.fallback()
          : route.abort("blockedbyclient");
      }),
    );
    yield* browserWork(() => splitRoutedReads(context, browserOrigin));
    const page = yield* browserWork(() => context.newPage());
    let reads = 0;
    diagnostics.accountProgress = { width, phase: "initial", responses: [], heads: [] };
    const progress = diagnostics.accountProgress;
    const inFlight = new Set(),
      idleWaiters = new Set();
    const finished = (request) => {
      inFlight.delete(request);
      if (!inFlight.size) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    };
    const resourceIdle = () =>
      inFlight.size === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.add(resolve));
    page.on("request", (request) => {
      const count = accountReads(request);
      reads += count;
      if (count) inFlight.add(request);
    });
    page.on("requestfinished", finished);
    page.on("requestfailed", (request) => {
      if (accountReads(request))
        (progress.failed ??= []).push({
          error: request.failure()?.errorText ?? "unknown",
          path: new URL(request.url()).pathname,
        });
      finished(request);
    });
    page.on("pageerror", (error) => {
      (diagnostics.pageErrors ??= []).push(redactLogText(String(error)));
    });
    const currentReads = [];
    page.on("response", (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.endsWith("/changes/current")) {
        currentReads.push(response);
        void response
          .json()
          .then((body) =>
            progress.heads.push({
              status: response.status(),
              revisions: body.revisions?.map(({ topic, revision }) => ({ topic, revision })),
            }),
          )
          .catch(() => undefined);
      }
      if (resources(new URL(response.url()))) {
        const entry = { status: response.status(), labels: [] };
        progress.responses.push(entry);
        void response
          .json()
          .then((body) => {
            entry.labels = Array.isArray(body) ? body.map(({ label }) => label) : [];
          })
          .catch(() => undefined);
      }
    });
    let gate;
    const activeHolds = new Set();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        gate?.release();
        await Promise.allSettled(activeHolds);
      }),
    );
    yield* browserWork(() =>
      page.route(resources, (route) => {
        if (gate === undefined || gate.claimed) return route.fallback();
        gate.claimed = true;
        const held = gate;
        const work = (async () => {
          // Hold the original request so authentication stays on the browser's normal path.
          held.enter();
          await held.released;
          await route.fallback();
        })();
        activeHolds.add(work);
        return work.finally(() => activeHolds.delete(work));
      }),
    );
    const row = (name) => page.getByRole("button", { name: `Manage ${name}`, exact: true }).first();
    const updating = page
      .getByRole("status")
      .filter({ hasText: /updating/i })
      .first();
    const flush = () =>
      Promise.all([
        page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        ),
        page.clock.runFor(80),
      ]);
    const shot = async (phase) => {
      const name = `accounts-${width}-${phase}.png`;
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        `Accounts at ${width}: no horizontal overflow`,
      );
      await page.screenshot({ path: join(directory, name), fullPage: true });
      screenshots.push(name);
    };
    yield* browserWork(() => page.clock.install());
    yield* browserWork(() =>
      page.goto(`${browserOrigin}/org/${h.actors.organization.slug}/accounts`),
    );
    yield* browserWork(() => row(label).waitFor());
    yield* browserWork(() =>
      currentReads.some((response) => response.status() === 200)
        ? Promise.resolve()
        : page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname.endsWith("/changes/current") &&
              response.status() === 200,
          ),
    );
    yield* browserWork(async () => {
      await resourceIdle();
      await updating.waitFor({ state: "hidden" });
      await flush();
      await resourceIdle();
      await shot("before");
    });
    const idle = reads;
    yield* browserWork(() => page.clock.runFor(6_100).then(flush));
    check(
      `Accounts at ${width}: unchanged virtual time over five seconds makes no resource read`,
      reads - idle,
      0,
    );

    let enter, release;
    const started = new Promise((resolve) => {
      enter = resolve;
    });
    const released = new Promise((resolve) => {
      release = resolve;
    });
    gate = { enter, release, released, claimed: false };
    const beforeHead = yield* head();
    const beforeReads = reads;
    const nextLabel = `Synthetic scoped account ${width}`;
    yield* h.request("PATCH", account, { label: nextLabel });
    yield* browserWork(() => started);
    const afterHead = yield* head();
    assert.ok(
      BigInt(afterHead) > BigInt(beforeHead),
      "the actual label PATCH advances the SQL trigger's revision",
    );
    checks.push(`Accounts at ${width}: real host write advanced SQL journal`);
    yield* browserWork(async () => {
      await row(label).waitFor();
      await updating.waitFor();
      check(
        `Accounts at ${width}: held update retains the original row`,
        await row(label).isVisible(),
        true,
      );
      check(
        `Accounts at ${width}: unaccepted label is not published`,
        await row(nextLabel).count(),
        0,
      );
      await shot("updating");
      progress.phase = "release-held-browser-request";
      const answered = page.waitForResponse(
        (response) => response.request().method() === "GET" && resources(new URL(response.url())),
      );
      gate.release();
      assert.equal((await answered).status(), 200, "the released browser read is authenticated");
      progress.phase = "await-new-label";
    });
    yield* browserWork(async () => {
      await row(nextLabel).waitFor();
      progress.phase = "await-updating-hidden";
      await updating.waitFor({ state: "hidden" });
      await resourceIdle();
      await flush();
      await shot("after");
    });
    gate = undefined;
    label = nextLabel;
    check(
      `Accounts at ${width}: one committed write makes exactly one resources/accounts read`,
      reads - beforeReads,
      1,
    );

    const quietReads = reads;
    yield* h.request("PATCH", account, { label });
    yield* barrier();
    check(`Accounts at ${width}: no-op PATCH leaves SQL head unchanged`, yield* head(), afterHead);
    yield* browserWork(() => page.clock.runFor(6_100).then(flush));
    check(
      `Accounts at ${width}: no-op PATCH makes no resources/accounts read`,
      reads - quietReads,
      0,
    );
    // Replay the producer's actual committed revision through its real outbox, never a made-up hint.
    yield* database.run({
      sql: `insert into hosted_change_pending(scope,topic,resource,revision)
        select scope,topic,resource,revision from hosted_change_heads
        where scope=$1 and topic='accounts' and resource='*'
        on conflict(scope,topic,resource) do update set revision=excluded.revision,updated_at=now()`,
      params: [scope],
    });
    yield* barrier();
    yield* browserWork(() => page.clock.runFor(6_100).then(flush));
    check(
      `Accounts at ${width}: duplicate committed revision makes no resources/accounts read`,
      reads - quietReads,
      0,
    );
    check(
      `Accounts at ${width}: duplicate delivery leaves SQL head unchanged`,
      yield* head(),
      afterHead,
    );
    yield* browserWork(() => page.goto("about:blank"));
  }
  diagnostics.accounts = { proved: true, widths: [1280, 390] };
  if (!accountsOnly) {
    yield* browserWork(() => h.fixture.scoped.initialize(pool.id, identity.user.id));
    let model = "synthetic-model-before";
    const baseline = yield* browserWork(() => h.fixture.scoped.commitRequest(model));
    let requestCount = baseline.count;
    assert.notEqual(baseline.hash, pool.id, "the SQL history hash differs from the actual AppId");
    check("native provisioned pool has an actual AppId", pool.id.startsWith("app_"), true);
    for (const width of [1280, 390]) {
      const context = yield* Effect.acquireRelease(
        Effect.promise(() =>
          browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true }),
        ),
        (context) => Effect.promise(() => context.close()),
      );
      const cookies = Redacted.value(yield* h.actors.owner.cookies);
      yield* browserWork(() => context.addCookies([...cookies]));
      yield* browserWork(() =>
        context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          const local =
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
            url.hostname.endsWith(".localhost");
          return !["http:", "https:"].includes(url.protocol) || local
            ? route.fallback()
            : route.abort("blockedbyclient");
        }),
      );
      const page = yield* browserWork(() => context.newPage());
      page.on("pageerror", (error) => {
        (diagnostics.pageErrors ??= []).push(redactLogText(String(error)));
      });
      yield* browserWork(() => page.clock.install());
      const frame = page.frameLocator(`iframe[title=${JSON.stringify(`${pool.name} app`)}]`);
      const requestRow = (name) =>
        frame.getByRole("button", { name: new RegExp(`Show metadata for ${name} at`) }).first();
      const historyReads = () =>
        h.fixture.scoped.reads.filter((read) => read.kind === "history").length;
      const overviewReads = () =>
        h.fixture.scoped.reads.filter((read) => read.kind === "poolOverview").length;
      const updating = frame
        .getByRole("status")
        .filter({ hasText: /updating/i })
        .first();
      const requestTotal = (count) =>
        frame.locator("#who > p").filter({
          hasText: new RegExp(`\\b${count} ${count === 1 ? "request" : "requests"} in 7 days`),
        });
      const flush = () =>
        Promise.all([
          page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          ),
          page.clock.runFor(80),
        ]);
      const shot = async (phase) => {
        const name = `pool-${width}-${phase}.png`;
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          `Pool shell at ${width}: no horizontal overflow`,
        );
        assert.ok(
          await frame
            .locator("body")
            .evaluate(
              (body) =>
                body.ownerDocument.documentElement.scrollWidth <=
                body.ownerDocument.defaultView.innerWidth + 1,
            ),
          `Pool app at ${width}: no horizontal overflow`,
        );
        await page.screenshot({ path: join(directory, name), fullPage: true });
        screenshots.push(name);
      };
      yield* browserWork(async () => {
        await page.goto(
          `${browserOrigin}/org/${h.actors.organization.slug}/apps/${pool.id}?view=app`,
        );
        await frame.getByRole("heading", { name: "Overview", exact: true }).waitFor();
        await frame.locator('a[href="#usage-history"]').first().waitFor();
        await requestTotal(requestCount).waitFor();
        await updating.waitFor({ state: "hidden" });
        await flush();
        await shot("overview-before");
      });
      const overviewIdle = overviewReads();
      yield* browserWork(() => page.clock.runFor(6_100).then(flush));
      check(
        `Pool Overview at ${width}: unchanged virtual time over five seconds makes no Overview read`,
        overviewReads() - overviewIdle,
        0,
      );
      const overviewHold = h.fixture.scoped.holdOverview();
      yield* Effect.addFinalizer(() => Effect.sync(() => overviewHold.release()));
      const beforeOverview = overviewReads(),
        overviewModel = `synthetic-overview-${width}`;
      const overviewCommit = yield* browserWork(() =>
        h.fixture.scoped.commitRequest(overviewModel),
      );
      assert.ok(
        overviewCommit.changes.some(
          ({ scope, hint }) =>
            scope === `pool:${pool.id}` &&
            hint.resource === pool.id &&
            hint.topic === "pool-usage" &&
            BigInt(hint.revision) > 0n,
        ),
        "Overview refresh follows a real capture's actual app revision through the signed hosted bridge",
      );
      checks.push(`Pool Overview at ${width}: real SQL commit delivered through hosted native DO`);
      yield* browserWork(() => overviewHold.started);
      yield* browserWork(async () => {
        await updating.waitFor();
        check(
          `Pool Overview at ${width}: held refresh retains accepted request total`,
          await requestTotal(requestCount).isVisible(),
          true,
        );
        check(
          `Pool Overview at ${width}: held response cannot publish new request total`,
          await requestTotal(overviewCommit.count).count(),
          0,
        );
        await shot("overview-updating");
        overviewHold.release();
        await requestTotal(overviewCommit.count).waitFor();
        await updating.waitFor({ state: "hidden" });
        await flush();
        await shot("overview-after");
      });
      requestCount = overviewCommit.count;
      model = overviewModel;
      check(
        `Pool Overview at ${width}: one committed hint makes exactly one Overview read`,
        overviewReads() - beforeOverview,
        1,
      );
      const overviewQuiet = overviewReads();
      yield* browserWork(() => h.fixture.scoped.noop());
      yield* browserWork(() => page.clock.runFor(6_100).then(flush));
      check(
        `Pool Overview at ${width}: unchanged capture makes no Overview read`,
        overviewReads() - overviewQuiet,
        0,
      );
      yield* browserWork(() => h.fixture.scoped.duplicate());
      yield* browserWork(() => page.clock.runFor(6_100).then(flush));
      check(
        `Pool Overview at ${width}: duplicate committed revision makes no Overview read`,
        overviewReads() - overviewQuiet,
        0,
      );
      yield* browserWork(async () => {
        await frame.locator('a[href="#usage-history"]').first().click();
        await requestRow(model).waitFor();
        await updating.waitFor({ state: "hidden" });
        await flush();
        await shot("before");
      });
      const idle = historyReads();
      yield* browserWork(() => page.clock.runFor(6_100).then(flush));
      check(
        `Pool history at ${width}: unchanged virtual time over five seconds makes no history read`,
        historyReads() - idle,
        0,
      );
      const hold = h.fixture.scoped.holdHistory();
      yield* Effect.addFinalizer(() => Effect.sync(() => hold.release()));
      const before = historyReads(),
        nextModel = `synthetic-history-${width}`;
      const committed = yield* browserWork(() => h.fixture.scoped.commitRequest(nextModel));
      assert.ok(
        committed.changes.some(
          ({ scope, hint }) =>
            scope === `pool:${pool.id}` &&
            hint.resource === pool.id &&
            hint.topic === "pool-usage" &&
            BigInt(hint.revision) > 0n,
        ),
        "real capture's outbox publishes the actual app ID through the signed hosted bridge",
      );
      checks.push(`Pool history at ${width}: real SQL commit delivered through hosted native DO`);
      yield* browserWork(() => hold.started);
      yield* browserWork(async () => {
        await updating.waitFor();
        check(
          `Pool history at ${width}: held refresh retains accepted requests`,
          await requestRow(model).isVisible(),
          true,
        );
        check(
          `Pool history at ${width}: held response cannot publish the new record`,
          await requestRow(nextModel).count(),
          0,
        );
        await shot("updating");
        hold.release();
        await requestRow(nextModel).waitFor();
        await updating.waitFor({ state: "hidden" });
        await flush();
        await shot("after");
      });
      model = nextModel;
      requestCount = committed.count;
      check(
        `Pool history at ${width}: one committed hint makes exactly one request-history read`,
        historyReads() - before,
        1,
      );
      const quiet = historyReads();
      yield* browserWork(() => h.fixture.scoped.noop());
      yield* browserWork(() => page.clock.runFor(6_100).then(flush));
      check(
        `Pool history at ${width}: unchanged capture makes no request-history read`,
        historyReads() - quiet,
        0,
      );
      yield* browserWork(() => h.fixture.scoped.duplicate());
      yield* browserWork(() => page.clock.runFor(6_100).then(flush));
      check(
        `Pool history at ${width}: duplicate committed revision makes no request-history read`,
        historyReads() - quiet,
        0,
      );
      yield* browserWork(() => page.goto("about:blank"));
    }
    diagnostics.pool = { proved: true, widths: [1280, 390], engine: h.fixture.scoped.engine };
  }
  check("browser has no uncaught product error", (diagnostics.pageErrors ??= []), []);
  return {
    complete: !accountsOnly,
    accountsProved: true,
    poolProved: !accountsOnly,
    checks,
    screenshots,
    syntheticOnly: true,
    diagnostics,
  };
});

try {
  const report = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(runtime)));
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      complete: report.complete,
      accountsProved: true,
      poolProved: report.poolProved,
      directory,
    }),
  );
} catch (error) {
  await writeFile(
    join(directory, "failure.json"),
    JSON.stringify(
      { complete: false, checks, screenshots, diagnostics, message: redactLogText(String(error)) },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  throw error;
}
