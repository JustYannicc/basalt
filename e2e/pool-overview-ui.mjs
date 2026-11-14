// The pool app's usage overview in a real browser: the actual pool app and the dashboard's kit,
// served by the hosted product, reading synthetic usage through the host's summary bridge. Every
// usage answer is synthetic and nothing leaves the fixture.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Effect, Redacted } from "effect";
import { root, runtime, until } from "./recipes/harness.mjs";
import { poolCloudHarness } from "./recipes/pool-cloud-harness.mjs";
import {
  capacityReply,
  historyReply,
  importedLabel,
  retainedFirstAt,
  seriesReply,
  summaryReply,
} from "./pool-overview-usage.mjs";

const { chromium } = createRequire(join(root, ".upstream/package.json"))("playwright");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/pool-overview-ui", randomBytes(6).toString("hex")),
);
// "after" checks the overview; "before" only records how the current pool app looks; "red" runs
// the correction checks against an older app and records each first failure.
const phase = ["before", "red"].includes(process.argv[3]) ? process.argv[3] : "after";
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(join(root, ".upstream"));
const checks = [];
const checked = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
// The red phase keeps going after a failed correction so one run records each first failure.
const reds = [];
const section = (name, effect) =>
  phase === "red"
    ? effect.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => reds.push({ section: name, failure: String(cause).slice(0, 600) })),
        ),
      )
    : effect;
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
  diagnostics.nativeView = inPool.nativeView?.state ?? "absent";
  diagnostics.nativeBinding =
    inPool.nativeAccountId === undefined
      ? "none"
      : inPool.nativeAccountId === null
        ? "withheld"
        : "bound";
  // History names come from the host's current members; a former member and imports stay unnamed.
  const people = {
    member: createHash("sha256").update(identity.user.id).digest("hex"),
    former: createHash("sha256").update("former-member").digest("hex"),
  };
  const usage = h.fixture.usage;
  usage.respond = (route, payload) => {
    if (route === "/pool/v1/usage/summary") return summaryReply(payload.input ?? payload);
    if (route === "/pool/v1/usage/series") return seriesReply(payload, inPool?.id ?? null, people);
    // Anything else, including the legacy overview, is counted and then refused.
    return undefined;
  };
  const capacityAsks = [];
  usage.capacity = (url) => {
    capacityAsks.push({
      days: Number(url.searchParams.get("days")),
      to: Number(url.searchParams.get("to")),
    });
    return capacityReply(url);
  };
  usage.history = (url) => historyReply(url, people);
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
  owner.setDefaultTimeout(phase === "red" ? 8_000 : 30_000);
  // Every request the pages send, by path only, with its time: the browser half of the inventory.
  const browserRequests = [];
  const started = Date.now();
  owner.on("request", (request) => {
    // A request from a frame with no address yet has no document to attribute it to.
    const where = (text) => URL.parse(text ?? "")?.pathname ?? "";
    const path = where(request.url());
    if (path.startsWith("/_executor/") || path.startsWith("/api/"))
      browserRequests.push({
        at: Date.now() - started,
        method: request.method(),
        path,
        document: where(request.frame()?.url()),
      });
  });
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
          // A transition cancelled by a resize is settled too; its promise rejects.
          .map((animation) => animation.finished.catch(() => undefined)),
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
  const input = (index) => {
    const call = calls("summary").at(index);
    return call?.payload.input ?? call?.payload;
  };
  const accountReads = () =>
    calls("series").filter((call) => call.payload.input?.by?.includes("account"));
  checked("the first load reads the summary once", calls("summary").length, 1);
  checked("the first load reads capacity once", capacityAsks.length, 1);
  checked("the first load never reads the legacy overview", calls("overview").length, 0);
  checked("collapsed labs read no account detail", accountReads().length, 0);
  checked("the summary read asks for labs", input(0).by, "provider");
  checked("capacity ends at the summary's exact end", capacityAsks[0].to, Date.parse(input(0).to));
  // Current incidents only: a client hang-up (499) is not a pool failure.
  checked(
    "the alert counts only real failures in the last hour",
    (yield* page(() => screen.getByRole("alert").first().innerText())).includes(
      "3 of 40 requests failed in the last hour",
    ),
    true,
  );

  yield* section(
    "honest coverage",
    Effect.gen(function* () {
      const pills = yield* page(() =>
        screen.getByRole("list", { name: "Coverage", exact: true }).innerText(),
      );
      checked(
        "an import certificate names the interval it proves",
        /Import complete \w+ \d+ to \w+ \d+/u.test(pills),
        true,
      );
      checked(
        "unproven capture is never called days without records",
        /Capture unproven on 1 day of \d+/u.test(pills) && !pills.includes("without records"),
        true,
      );
    }),
  );
  yield* section(
    "known-subset tokens and gapped sparks",
    Effect.gen(function* () {
      const tokens = yield* page(() =>
        screen.getByRole("region", { name: "Tokens", exact: true }).innerText(),
      );
      checked(
        "a partly counted token total says it is a known subset",
        tokens.includes("≥") && /known for all but 4 requests/u.test(tokens),
        true,
      );
      checked(
        "an unpriced day breaks the cost sparkline instead of dipping to zero",
        yield* page(() =>
          screen
            .getByRole("region", { name: "Est. cost", exact: true })
            .locator("polyline")
            .count(),
        ),
        2,
      );
    }),
  );
  yield* shoot("overview", screen);

  // The metric is the page's own choice; it never reads again.
  yield* page(() => screen.getByRole("tab", { name: "Tokens", exact: true }).click());
  yield* page(() =>
    screen.getByRole("heading", { name: "Tokens per day by lab", exact: true }).waitFor(),
  );
  checked("switching the metric reads nothing", calls("summary").length, 1);

  yield* section(
    "breakdown switch keeps the answered bounds",
    Effect.gen(function* () {
      const capacityBefore = capacityAsks.length;
      yield* page(() => screen.getByRole("tab", { name: "Model", exact: true }).click());
      yield* page(() => screen.getByRole("heading", { name: "By model", exact: true }).waitFor());
      checked("a model breakdown is one more summary read", calls("summary").length, 2);
      checked("a model breakdown reads no capacity", capacityAsks.length, capacityBefore);
      checked("that read asks for models", input(1).by, "model");
      checked(
        "the model read keeps the paired lab answer's exact bounds",
        [input(1).from, input(1).to],
        [input(0).from, input(0).to],
      );
      checked(
        "an unrecorded model stays unknown",
        (yield* page(() => screen.getByText("Unknown model").count())) > 0,
        true,
      );
    }),
  );
  yield* shoot("models", screen);
  yield* page(() => screen.getByRole("tab", { name: "Lab", exact: true }).click());
  yield* page(() => screen.getByRole("heading", { name: "By lab", exact: true }).waitFor());
  yield* page(() => screen.getByRole("tab", { name: "Est. cost", exact: true }).click());

  const toggles = screen.getByRole("button", { name: /^Accounts/u });
  const summaryCount = (count) =>
    until(
      Effect.sync(() => calls("summary")),
      (list) => list.length === count,
      `the summary was not read ${count} times`,
    );
  yield* section(
    "shared drilldown follows the range",
    Effect.gen(function* () {
      checked("both labs offer their accounts", yield* page(() => toggles.count()), 2);
      yield* page(() => toggles.nth(1).click());
      yield* page(() => screen.getByText(importedLabel).waitFor());
      checked("opening a lab reads every account page once", accountReads().length, 2);
      checked(
        "the merged page keeps the imported account's own label",
        yield* page(() => screen.getByText(importedLabel).count()),
        1,
      );
      yield* page(() => screen.getByText("Imported only").first().waitFor());
      yield* page(() => screen.getByText("No account recorded").waitFor());
      yield* page(() => screen.getByText("Unattributed").first().waitFor());
      yield* page(() => toggles.nth(0).click());
      yield* page(() => screen.getByText(inPool.label, { exact: true }).first().waitFor());
      checked("a second lab reuses the same account read", accountReads().length, 2);

      // An open lab reads again for a new range by itself, pinned to the answered bounds.
      const summaries = calls("summary").length;
      yield* page(() => screen.getByRole("tab", { name: "30 days", exact: true }).click());
      yield* summaryCount(summaries + 1);
      yield* page(() => screen.getByText(importedLabel).waitFor());
      checked("open labs read their accounts again for the new range", accountReads().length, 4);
      // The 30-day answer is sparse: only its last week has usage. The daily average still
      // spreads over all 30 calendar days instead of over the days that happened to return rows.
      const sparse = summaryReply(input(-1));
      const spent = sparse.daily
        .flatMap((group) => group.buckets)
        .reduce(
          (sum, bucket) =>
            sum +
            (bucket.details?.apiEstimate.status === "available"
              ? Number(bucket.details.apiEstimate.amount)
              : 0),
          0,
        );
      const perDay = new Intl.NumberFormat("en", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(spent / 30);
      checked(
        "a sparse 30-day range averages over all 30 calendar days",
        (yield* page(() =>
          screen.getByRole("region", { name: "Est. cost per day", exact: true }).innerText(),
        )).includes(perDay),
        true,
      );
      const read = accountReads().at(-1).payload.input;
      checked(
        "account reads pin to the answered summary bounds",
        [read.from, read.to],
        [input(-1).from, input(-1).to],
      );
      // A range whose accounts outrun the page budget says so instead of looking complete.
      yield* page(() => screen.getByRole("tab", { name: "90 days", exact: true }).click());
      yield* summaryCount(summaries + 2);
      yield* page(() =>
        screen
          .getByText(/Accounts are partial/u)
          .first()
          .waitFor(),
      );
      checked("an overflowing account read stops at its page budget", accountReads().length, 24);
      yield* page(() => screen.getByRole("tab", { name: "7 days", exact: true }).click());
      yield* summaryCount(summaries + 3);
      yield* page(() => screen.getByText(importedLabel).waitFor());
    }),
  );

  yield* section(
    "since the first retained request",
    Effect.gen(function* () {
      const summaries = calls("summary").length;
      const pairs = capacityAsks.length;
      yield* page(() => screen.getByRole("tab", { name: "Since May", exact: true }).click());
      yield* summaryCount(summaries + 1);
      // Capacity is read beside the summary; wait for it rather than for a fixed time.
      yield* until(
        Effect.sync(() => capacityAsks.length),
        (count) => count === pairs + 1,
        "the since-start range did not read capacity once",
      );
      const asked = input(-1);
      checked(
        "the since-start range starts at the first retained Zurich day",
        asked.from,
        "2026-05-02T22:00:00.000Z",
      );
      checked(
        "it is the retained start, not the training coverage",
        retainedFirstAt.slice(0, 10),
        "2026-05-03",
      );
      const pair = capacityAsks.at(-1);
      checked("capacity pairs with the same end", pair.to, Date.parse(asked.to));
      checked(
        "capacity covers the same whole days",
        pair.days,
        Math.ceil((Date.parse(asked.to) - Date.parse(asked.from)) / 86_400_000),
      );
      yield* page(() => screen.getByText(/the day of the first retained request/u).waitFor());
      yield* shoot("since", screen);
      yield* page(() => screen.getByRole("tab", { name: "7 days", exact: true }).click());
      yield* summaryCount(summaries + 2);
      yield* page(() => screen.getByText(importedLabel).waitFor());
    }),
  );

  // Producer forecasts only; a lab without enough weeks says so instead of guessing.
  yield* page(() => screen.getByText("Not enough full weeks of history yet").first().waitFor());
  checked(
    "a forecast shows the producer's confidence",
    (yield* page(() => screen.getByText("Medium confidence").count())) > 0,
    true,
  );
  yield* page(() => screen.getByRole("heading", { name: "When we use it", exact: true }).waitFor());

  // This harness's pool account has no native source binding, so its provider returned no health:
  // the row says so plainly, and imported or unattributed usage never claims live health.
  yield* section(
    "unavailable account health",
    Effect.gen(function* () {
      checked(
        "the pool view returned no provider health in this harness",
        diagnostics.nativeView,
        "absent",
      );
      yield* page(() =>
        screen
          .locator("#accounts-codex")
          .getByText("Health unavailable", { exact: true })
          .waitFor(),
      );
      checked(
        "imported and unattributed usage shows no account health",
        yield* page(() =>
          screen.locator("#accounts-claude").getByText("Health unavailable").count(),
        ),
        0,
      );
    }),
  );

  // Capacity renders the pool's own verdict from its history, in the lab's own unit.
  checked(
    "capacity reads its history without an error",
    yield* page(() => screen.getByText("This pool endpoint does not exist.").count()),
    0,
  );
  yield* page(() => screen.locator("#capacity").getByText("ChatGPT").first().waitFor());
  yield* page(() => screen.getByRole("list", { name: "Banked resets" }).waitFor());
  checked(
    "no reset can be spent from the overview",
    yield* page(() => screen.getByRole("button", { name: /use reset/iu }).count()),
    0,
  );
  yield* shoot("drilldown", screen, "#usage-breakdown-heading");
  yield* section(
    "hourly heatmap values on a phone",
    Effect.gen(function* () {
      yield* page(() => owner.setViewportSize({ width: 390, height: 844 }));
      const toggle = screen.getByRole("button", { name: "Show hourly values", exact: true });
      yield* page(() => toggle.scrollIntoViewIfNeeded().then(() => toggle.click()));
      const hours = screen.getByRole("list", { name: "Hourly values", exact: true });
      const known = yield* page(() =>
        hours.getByRole("listitem").filter({ hasText: "Mon 10:00" }).innerText(),
      );
      checked("a phone reads a known hour's value", /2K tokens an hour/u.test(known), true);
      const unknown = yield* page(() =>
        hours.getByRole("listitem").filter({ hasText: "Wed 12:00" }).innerText(),
      );
      checked(
        "a phone reads an unrecorded hour as unknown",
        unknown.includes("Tokens not recorded"),
        true,
      );
      checked(
        "the hourly list keeps the page within a phone's width",
        yield* page(() =>
          screen
            .locator("body")
            .evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
            ),
        ),
        true,
      );
      yield* page(() => owner.setViewportSize({ width: 1280, height: 900 }));
    }),
  );
  yield* shoot("forecast", screen, "#forecast-heading");
  yield* shoot("capacity", screen, "#capacity-heading");

  // History: the host's own tab, opened already filtered, loaded with authorized names.
  const historyScreen = owner.frameLocator(historyFrame);
  const historyLoaded = () =>
    historyScreen.getByRole("heading", { name: "Requests", exact: true }).waitFor();
  yield* section(
    "failures open History loaded and filtered",
    Effect.gen(function* () {
      const summaries = calls("summary").length;
      yield* page(() =>
        screen.getByRole("button", { name: "See failed requests", exact: true }).click(),
      );
      yield* page(historyLoaded);
      checked(
        "the History document carries the failure filter",
        (yield* page(() => owner.locator(historyFrame).getAttribute("src"))).includes(
          "status=failed",
        ),
        true,
      );
      yield* page(() =>
        historyScreen
          .getByRole("status", { name: "History filters", exact: true })
          .getByText("Failed requests")
          .waitFor(),
      );
      const listed = yield* page(() =>
        historyScreen.getByRole("region", { name: "Request history", exact: true }).innerText(),
      );
      checked(
        "only failed requests are listed",
        listed.includes("Failed") && !listed.includes("Completed"),
        true,
      );
      checked(
        "a current member is named from the host's directory",
        (yield* page(() => historyScreen.getByText(identity.user.name).count())) > 0,
        true,
      );
      yield* shoot("history", historyScreen);
      yield* page(() => owner.goBack().then(() => heading.waitFor()));
      checked(
        "Back returns to the kept overview without reading it again",
        calls("summary").length,
        summaries,
      );
      checked(
        "the kept overview keeps its open labs",
        yield* page(() => screen.getByText(importedLabel).count()),
        1,
      );
    }),
  );
  yield* section(
    "a lab opens History filtered and survives a reload",
    Effect.gen(function* () {
      yield* page(() =>
        screen.getByRole("button", { name: "History", exact: true }).first().click(),
      );
      yield* page(historyLoaded);
      const filters = historyScreen.getByRole("status", { name: "History filters", exact: true });
      yield* page(() => filters.getByText("ChatGPT").waitFor());
      yield* page(() => owner.reload());
      yield* page(historyLoaded);
      yield* page(() => filters.getByText("ChatGPT").waitFor());
      checks.push("a reload keeps History's filters and loads again");
    }),
  );
  yield* section(
    "sparse failures page through every source page",
    Effect.gen(function* () {
      // The host carries page filters set through navigation, so enter from the alert, then widen
      // to every retained day while keeping the failure filter.
      yield* page(() => owner.goto(`${app}?view=app`).then(() => heading.waitFor()));
      yield* page(() =>
        screen.getByRole("button", { name: "See failed requests", exact: true }).click(),
      );
      yield* page(historyLoaded);
      yield* page(() =>
        historyScreen.getByRole("radio", { name: "All retained", exact: true }).click(),
      );
      yield* page(historyLoaded);
      const rows = historyScreen
        .getByRole("region", { name: "Request history", exact: true })
        .locator("tbody tr");
      // The first source page holds 2 of the 6 failures; two more pages hold the rest.
      yield* until(
        page(() => rows.count()),
        (count) => count === 2,
        "the first loaded page did not list its two failures",
      );
      const before = usage.log.filter(
        (entry) => entry.route === "GET /pool/v1/usage/history",
      ).length;
      yield* page(() => historyScreen.getByRole("button", { name: "Next", exact: true }).click());
      yield* until(
        page(() => rows.count()),
        (count) => count === 6,
        "Next did not gather the remaining failures",
      );
      checked(
        "Next read the remaining source pages once",
        usage.log.filter((entry) => entry.route === "GET /pool/v1/usage/history").length - before,
        2,
      );
      checked(
        "with the source exhausted, Next is done",
        yield* page(() =>
          historyScreen.getByRole("button", { name: "Next", exact: true }).isDisabled(),
        ),
        true,
      );
    }),
  );
  yield* page(() =>
    owner
      .goto(`${app}?page=history`)
      .then(() =>
        historyScreen.getByRole("heading", { name: "Usage history", exact: true }).waitFor(),
      ),
  );
  yield* page(historyLoaded);
  yield* page(() =>
    historyScreen
      .getByText(/retained records/u)
      .first()
      .waitFor(),
  );
  checks.push("a direct link opens History loaded");
  yield* section(
    "unfiltered History keeps unknown people unnamed",
    Effect.gen(function* () {
      checked(
        "a former member stays unnamed",
        (yield* page(() => historyScreen.getByText("Name unavailable").count())) > 0,
        true,
      );
      yield* shoot("history-all", historyScreen);
    }),
  );
  checked("no screen ever read the legacy overview", calls("overview").length, 0);
  diagnostics.requests = usage.requests.slice(before);
  if (phase === "red") return { phase, reds, checks };
  // The host-to-pool half of the inventory, with the pool view's own refresh cadence.
  const views = usage.log.filter((entry) => entry.route === "GET /pool/v1/pool").map((e) => e.at);
  return {
    checks,
    phase,
    syntheticOnly: true,
    nativeView: diagnostics.nativeView,
    nativeBinding: diagnostics.nativeBinding,
    calls: usage.calls.map((call) => ({
      route: call.route,
      by: call.payload?.input?.by ?? call.payload?.by ?? null,
    })),
    capacityAsks,
    initialRequests: loaded,
    poolLog: usage.log.map((entry) => ({ at: entry.at - started, route: entry.route })),
    poolViewIntervals: views.slice(1).map((at, index) => at - views[index]),
    browserRequests,
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
    JSON.stringify({ phase, checks, reds, message: String(error), diagnostics }, null, 2) + "\n",
    { mode: 0o600 },
  );
  throw error;
}
