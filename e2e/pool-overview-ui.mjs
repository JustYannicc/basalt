// The pool app's usage overview in a real browser: the actual pool app and the dashboard's kit,
// served by the hosted product, reading synthetic usage through the host's summary bridge. Every
// usage answer is synthetic and nothing leaves the fixture.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Effect, Redacted } from "effect";
import { root, runtime, until } from "./recipes/harness.mjs";
import { poolCloudHarness } from "./recipes/pool-cloud-harness.mjs";
import { capacityReply, importedLabel, seriesReply, summaryReply } from "./pool-overview-usage.mjs";

const { chromium } = createRequire(join(root, ".upstream/package.json"))("playwright");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/pool-overview-ui", randomBytes(6).toString("hex")),
);
// "after" checks the overview; "before" only records how the current pool app looks.
const phase = process.argv[3] === "before" ? "before" : "after";
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(join(root, ".upstream"));
const checks = [];
const checked = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
const page = (fn) => Effect.promise(fn);
const diagnostics = {};
const screenFrame = '[data-app-frames] iframe:not([src*="/history"])';
const historyFrame = '[data-app-frames] iframe[src*="/history"]';

const program = Effect.gen(function* () {
  const h = yield* poolCloudHarness(directory, { resets: true });
  const identity = yield* h.request("GET", "/api/auth/get-session");
  const pool = yield* until(
    h.request("GET", `${h.prefix}/apps`),
    (apps) => apps.some((app) => app.name === `${identity.user.name}'s pool`),
    "native pool provisioning did not finish",
  ).pipe(Effect.map((apps) => apps.find((app) => app.name === `${identity.user.name}'s pool`)));
  yield* until(
    h.request("GET", `${h.appPath(pool.id)}/accounts/app`),
    (links) => links.some((link) => link.requirement === "pool" && link.hostManaged),
    "pool access not linked",
  );
  // One real account with banked resets, so capacity and the per-lab reset label have a source.
  const providerApp = yield* h.request("POST", `${h.prefix}/apps/install`, {
    entry: "provider-openai",
    name: "Synthetic openai",
  });
  const id = "synthetic-codex-overview";
  h.fixture.prepareAcquisition(null, id, "codex", 3);
  const pending = yield* h.request(
    "POST",
    `${h.appPath(providerApp.id)}/accounts/app/openai/connections`,
    { destination: { kind: "shared", audience: { kind: "everyone" } } },
  );
  const connection = `${h.prefix}/connections/${pending.id}/interactive`;
  yield* h.request("POST", `${connection}/start`, { method: "codex" });
  const saved = yield* h.request("GET", `${connection}/status`);
  checked("the synthetic account saves through the real host", saved.state, "connected");
  yield* h.request("PUT", `${h.appPath(pool.id)}/accounts/app/openai/${saved.account.id}`);
  const account = `${h.prefix}/accounts/${saved.account.id}`;
  yield* until(
    h.raw(
      "owner",
      "GET",
      `${h.prefix}/pools/${pool.id}/accounts/${saved.account.id}/reset-credits`,
    ),
    (response) => response.status === 200,
    "saved account membership did not reach the backend",
  );
  yield* h.request("PATCH", account, { label: "Synthetic Codex" });
  yield* h.request("POST", `${account}/observations/refresh`);
  yield* until(
    h.request("GET", `${account}/observations`),
    (view) =>
      view.reports.some((report) =>
        report.result?.observation.balances.some((balance) => balance.unit === "resets"),
      ),
    "the account's reading has no banked resets",
  );

  // The worker keys an in-pool account by the pool's own account ID, the one its view lists.
  const poolView = yield* h.call(pool.id, "view");
  const unwrap = (value) =>
    value && typeof value === "object" && !Array.isArray(value.accounts)
      ? unwrap(value.value ?? value.result ?? value.data)
      : value;
  const listed = unwrap(poolView)?.accounts ?? [];
  diagnostics.poolViewShape = Object.keys(poolView ?? {});
  const inPool = listed[0];
  assert.ok(inPool, "the pool lists its account");
  diagnostics.poolAccounts = listed.map((entry) => ({
    id: entry.id === saved.account.id ? "host id" : entry.id ? "pool id" : null,
    native: entry.nativeAccountId === saved.account.id,
    label: entry.label,
  }));
  const usage = h.fixture.usage;
  usage.respond = (route, payload) => {
    if (route === "/pool/v1/usage/summary") return summaryReply(payload.input ?? payload);
    if (route === "/pool/v1/usage/series") return seriesReply(payload, inPool?.id ?? null);
    // Anything else, including the legacy overview, is counted and then refused.
    return undefined;
  };
  usage.capacity = capacityReply;
  const calls = (route) => usage.calls.filter((call) => call.route === `/pool/v1/usage/${route}`);

  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch({ headless: true })),
    (browser) => Effect.promise(() => browser.close()),
  );
  const context = yield* Effect.promise(() =>
    browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: "light",
      recordVideo: { dir: join(directory, "video"), size: { width: 1280, height: 900 } },
    }),
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => context.close()));
  const owner = yield* Effect.promise(() => context.newPage());
  const cookies = Redacted.value(yield* h.actors.owner.cookies);
  yield* Effect.promise(() => context.addCookies([...cookies]));
  const screen = owner.frameLocator(screenFrame);
  const app = `${h.origin}/org/${h.actors.organization.slug}/apps/${pool.id}`;
  // Finite CSS transitions only: a screenshot waits for every running animation to end.
  const settled = (frame) =>
    frame.locator("body").evaluate(() =>
      Promise.all(
        document
          .getAnimations()
          // A loading pulse repeats forever; only finite transitions are waited for.
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      ),
    );
  const shoot = (name, frame, anchor) =>
    Effect.gen(function* () {
      for (const scheme of ["light", "dark"])
        for (const [width, height] of [
          [1280, 900],
          [390, 844],
        ]) {
          yield* page(() => owner.emulateMedia({ colorScheme: scheme }));
          yield* page(() => owner.setViewportSize({ width, height }));
          yield* page(() => settled(frame));
          // Phone width has a side gutter and no horizontal page scroll. Content an SVG clips
          // doesn't scroll the page, so the page's own scroll width decides.
          const scroll = yield* page(() =>
            frame.locator("body").evaluate(() => {
              const limit = document.documentElement.clientWidth;
              return {
                overflow: document.documentElement.scrollWidth - limit,
                wider: Array.from(document.body.querySelectorAll("*"))
                  .filter((element) => element.getBoundingClientRect().right > limit + 1)
                  .slice(0, 5)
                  .map((element) => element.tagName.toLowerCase()),
              };
            }),
          );
          if (width === 390 && phase === "after") {
            diagnostics[`${name}-${scheme}-wider`] = scroll.wider;
            checked(
              `${name} has no horizontal scroll at 390 in ${scheme}`,
              scroll.overflow <= 0,
              true,
            );
          }
          yield* page(() =>
            anchor === undefined
              ? frame.locator("body").evaluate(() => window.scrollTo(0, 0))
              : frame.locator(anchor).evaluate((element) => {
                  window.scrollTo(0, 0);
                  element.scrollIntoView({ block: "start" });
                }),
          );
          yield* page(() =>
            owner.screenshot({ path: join(directory, `${phase}-${name}-${width}-${scheme}.png`) }),
          );
        }
      yield* page(() => owner.emulateMedia({ colorScheme: "light" }));
      yield* page(() => owner.setViewportSize({ width: 1280, height: 900 }));
    });

  const before = usage.requests.length;
  yield* page(() =>
    owner
      .goto(`${app}?view=app`)
      .then(() => screen.locator("h1").first().waitFor({ timeout: 60_000 })),
  );
  if (phase === "before") {
    // The red half of the negative control: the current app has no usage overview and reads the
    // legacy overview instead of the summary.
    // The current app keeps retrying a refused read, so it never goes idle; its heading and
    // its first legacy read mark the settled first screen.
    yield* until(
      Effect.sync(() => calls("overview")),
      (list) => list.length > 0,
      "the current app never read its legacy overview",
    );
    yield* page(() => screen.getByRole("heading", { name: "Overview", exact: true }).waitFor());
    yield* shoot("overview", screen);
    const red = {
      overviewHeading: yield* page(() =>
        screen.getByRole("heading", { name: "How much are we using?", exact: true }).count(),
      ),
      legacyCalls: calls("overview").length,
      summaryCalls: calls("summary").length,
      hostHistoryTab: yield* page(() =>
        owner.getByRole("link", { name: "History", exact: true }).count(),
      ),
    };
    diagnostics.requests = usage.requests.slice(before);
    return { checks, phase, red, requests: diagnostics.requests };
  }

  // One refresh is one summary read plus the existing capacity read; the legacy read never runs.
  const heading = screen.getByRole("heading", { name: "How much are we using?", exact: true });
  yield* page(() => heading.waitFor());
  yield* page(() => screen.getByText("Where it's heading").waitFor());
  yield* page(() =>
    screen.getByRole("heading", { name: "Do we have enough accounts?", exact: true }).waitFor(),
  );
  yield* page(() => owner.waitForLoadState("networkidle"));
  const loaded = usage.requests.slice(before);
  diagnostics.initialRequests = loaded;
  checked("the first load reads the summary once", calls("summary").length, 1);
  checked("the first load never reads the legacy overview", calls("overview").length, 0);
  checked("collapsed labs read no account detail", calls("series").length, 0);
  checked(
    "the summary read asks for labs over whole Zurich days",
    calls("summary")[0].payload.input?.by ?? calls("summary")[0].payload.by,
    "provider",
  );

  // Current incidents only: a client hang-up (499) is not a pool failure.
  checked(
    "the alert counts only real failures in the last hour",
    (yield* page(() => screen.getByRole("alert").first().innerText())).includes(
      "3 of 40 requests failed in the last hour",
    ),
    true,
  );
  yield* shoot("overview", screen);

  // The metric is the page's own choice; it never reads again.
  yield* page(() => screen.getByRole("tab", { name: "Tokens", exact: true }).click());
  yield* page(() =>
    screen.getByRole("heading", { name: "Tokens per day by lab", exact: true }).waitFor(),
  );
  checked("switching the metric reads nothing", calls("summary").length, 1);

  // Models are one more summary read of the same range; capacity doesn't change with them.
  const capacityReads = () =>
    usage.requests.filter((request) => request === "GET /pool/v1/usage/capacity").length;
  const capacityBefore = capacityReads();
  yield* page(() => screen.getByRole("tab", { name: "Model", exact: true }).click());
  yield* page(() => screen.getByRole("heading", { name: "By model", exact: true }).waitFor());
  // The model view appears only with its own answer, never over the lab answer it replaces.
  checked("a model breakdown is one more summary read", calls("summary").length, 2);
  checked("a model breakdown reads no capacity", capacityReads(), capacityBefore);
  checked(
    "that read asks for models",
    calls("summary")[1].payload.input?.by ?? calls("summary")[1].payload.by,
    "model",
  );
  checked(
    "an unrecorded model stays unknown",
    (yield* page(() => screen.getByText("Unknown model").count())) > 0,
    true,
  );
  yield* shoot("models", screen);
  yield* page(() => screen.getByRole("tab", { name: "Lab", exact: true }).click());
  yield* page(() => screen.getByRole("heading", { name: "By lab", exact: true }).waitFor());
  yield* page(() => screen.getByRole("tab", { name: "30 days", exact: true }).click());
  yield* until(
    Effect.sync(() => calls("summary")),
    (list) => list.length === 4,
    "a range change did not read once",
  );
  const thirty = calls("summary")[3].payload.input ?? calls("summary")[3].payload;
  yield* until(
    Effect.sync(capacityReads),
    (count) => count === capacityBefore + 1,
    "a range change did not read capacity once",
  );
  checks.push("a range change reads capacity once");
  // Whole Zurich days back to a midnight, through today so far.
  const calendarDay = (at) =>
    Date.parse(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date(at)),
    );
  checked(
    "a 30-day range asks for 30 Zurich days",
    (calendarDay(thirty.to) - calendarDay(thirty.from)) / 86_400_000 + 1,
    30,
  );
  yield* page(() => screen.getByRole("tab", { name: "7 days", exact: true }).click());
  yield* page(() => screen.getByRole("tab", { name: "Est. cost", exact: true }).click());
  yield* until(
    Effect.sync(() => calls("summary")),
    (list) => list.length === 5,
    "returning to 7 days did not read once",
  );

  // Producer forecasts only; a lab without enough weeks says so instead of guessing.
  yield* page(() => screen.getByText("Not enough full weeks of history yet").first().waitFor());
  checked(
    "a forecast shows the producer's confidence",
    (yield* page(() => screen.getByText("Medium confidence").count())) > 0,
    true,
  );
  yield* page(() => screen.getByRole("heading", { name: "When we use it", exact: true }).waitFor());

  // Account detail loads on the first opened lab, once, across both pages.
  const toggles = screen.getByRole("button", { name: /^Accounts/u });
  checked("both labs offer their accounts", yield* page(() => toggles.count()), 2);
  yield* page(() => toggles.nth(1).click());
  yield* page(() => screen.getByText(importedLabel).waitFor());
  checked("opening a lab reads every account page once", calls("series").length, 2);
  checked(
    "the merged page keeps the imported account's own label",
    yield* page(() => screen.getByText(importedLabel).count()),
    1,
  );
  yield* page(() => screen.getByText("Imported only").first().waitFor());
  yield* page(() => screen.getByText("No account recorded").waitFor());
  yield* page(() => screen.getByText("Unattributed").first().waitFor());
  yield* page(() => toggles.nth(0).click());
  // An in-pool account reads as the pool names it.
  yield* page(() => screen.getByText(inPool.label, { exact: true }).first().waitFor());
  checked("a second lab reuses the same account read", calls("series").length, 2);

  // Capacity renders the pool's own verdict from its history, in the lab's own unit.
  checked(
    "capacity reads its history without an error",
    yield* page(() => screen.getByText("This pool endpoint does not exist.").count()),
    0,
  );
  yield* page(() => screen.locator("#capacity").getByText("ChatGPT").first().waitFor());
  // Banked resets are counted per lab and kind; spending stays in Accounts.
  yield* page(() => screen.getByRole("list", { name: "Banked resets" }).waitFor());
  checked(
    "no reset can be spent from the overview",
    yield* page(() => screen.getByRole("button", { name: /use reset/iu }).count()),
    0,
  );
  yield* shoot("drilldown", screen, "#usage-breakdown-heading");
  yield* shoot("forecast", screen, "#forecast-heading");
  yield* shoot("capacity", screen, "#capacity-heading");

  // History is the host's own tab for the app's page; Back returns to the same overview.
  const summaries = calls("summary").length;
  yield* page(() =>
    owner
      .getByRole("link", { name: "History", exact: true })
      .click()
      .then(() =>
        owner
          .frameLocator(historyFrame)
          .getByRole("heading", { name: "Usage history", exact: true })
          .waitFor(),
      ),
  );
  checked(
    "History has no duplicate in-frame header",
    yield* page(() =>
      owner.frameLocator(historyFrame).getByRole("button", { name: "Back", exact: true }).count(),
    ),
    0,
  );
  yield* shoot("history", owner.frameLocator(historyFrame));
  yield* page(() => owner.goBack().then(() => heading.waitFor()));
  checked(
    "Back returns to the kept overview without reading it again",
    calls("summary").length,
    summaries,
  );
  checked(
    "the kept overview keeps its open lab",
    yield* page(() => screen.getByText(importedLabel).count()),
    1,
  );
  yield* page(() =>
    owner
      .goto(`${app}?page=history`)
      .then(() =>
        owner
          .frameLocator(historyFrame)
          .getByRole("heading", { name: "Usage history", exact: true })
          .waitFor(),
      ),
  );
  checks.push("a direct link opens History");
  checked("no screen ever read the legacy overview", calls("overview").length, 0);
  diagnostics.requests = usage.requests.slice(before);
  return {
    checks,
    phase,
    syntheticOnly: true,
    calls: usage.calls.map((call) => call.route),
    initialRequests: loaded,
    runtimeDirectory: h.runtimeDirectory,
  };
});

try {
  const report = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(runtime)));
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify({ checks: checks.length, directory }));
} catch (error) {
  await writeFile(
    join(directory, "failure.json"),
    JSON.stringify({ phase, checks, message: String(error), diagnostics }, null, 2) + "\n",
    { mode: 0o600 },
  );
  throw error;
}
