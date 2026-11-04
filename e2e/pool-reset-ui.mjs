// The banked reset control in a real browser against the hosted app and the synthetic pool
// fixture. Every provider reply is synthetic; no request leaves the fixture, and nothing spends
// without a click on "Use reset" or "Retry" inside the confirm.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Effect, Redacted } from "effect";
import { root, runtime, until } from "./recipes/harness.mjs";
import { poolCloudHarness } from "./recipes/pool-cloud-harness.mjs";

const { chromium } = createRequire(join(root, ".upstream/package.json"))("playwright");
const directory = resolve(
  process.argv[2] ?? join(root, ".generated/pool-reset-ui", randomBytes(6).toString("hex")),
);
await mkdir(directory, { recursive: true, mode: 0o700 });
process.chdir(join(root, ".upstream"));
const checks = [];
const checked = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push(name);
};
const id = "synthetic-codex-reset-ui";
const label = "Synthetic Codex";
const page = (fn) => Effect.promise(fn);
// What the setup saw last, written to failure.json so a failed run names the hop that broke.
const diagnostics = {};

/**
 * Re-run the host's two observation checks on what the pool answered: the result schema and the
 * credential-exposure scan against the binding reference. References are recorded only as their
 * length and a hash, and masked in the raw answers.
 */
const diagnosePool = (traces) => {
  const upstream = join(root, ".upstream");
  const load = (path) => import(pathToFileURL(join(upstream, path)).href);
  const loaded = Promise.all([
    load("packages/apps/src/contracts/account-observation.ts"),
    load("packages/utils/src/account-display-privacy.ts"),
    import(
      pathToFileURL(createRequire(join(upstream, "packages/apps/package.json")).resolve("effect"))
        .href
    ),
  ])
    .then(([contract, privacy, effect]) => ({
      AccountObservationResult: contract.AccountObservationResult,
      privateObservationStrings: privacy.privateObservationStrings,
      Schema: effect.Schema,
    }))
    .catch((error) => {
      diagnostics.poolCheckLoad = String(error).slice(0, 300);
      return undefined;
    });
  const strings = (value, out = []) => {
    if (typeof value === "string") out.push(value);
    else if (value && typeof value === "object")
      for (const item of Object.values(value)) strings(item, out);
    return out;
  };
  return loaded.then((checks) =>
    traces.map((trace) => {
      const ref = trace.reference;
      const mask = (text) => (ref ? text.split(ref).join("<ref>") : text);
      let body;
      try {
        body = JSON.parse(trace.body);
      } catch {
        body = undefined;
      }
      const candidates = [
        ["observation", body?.observation],
        ["result.observation", body?.result?.observation],
        ["result", body?.result?.observedAt === undefined ? undefined : body.result],
      ].filter(([, value]) => value !== undefined && value !== null);
      const verdicts = candidates.map(([at, value]) => {
        if (checks === undefined) return { at, checks: "unavailable" };
        const decoded = checks.Schema.decodeUnknownExit(checks.AccountObservationResult)(value);
        const exposed =
          ref === undefined ? undefined : !checks.privateObservationStrings(value, {}, ref);
        const colliding = exposed ? strings(value).filter((text) => text.includes(ref)).length : 0;
        return {
          at,
          decode: decoded._tag === "Success" ? "ok" : String(decoded.cause).slice(0, 600),
          privacy: exposed === undefined ? "no reference" : exposed ? "rejected" : "ok",
          ...(exposed
            ? { collidingTokenLength: ref.length, stringsContainingReference: colliding }
            : {}),
        };
      });
      return {
        method: trace.method,
        route: trace.route,
        status: trace.status,
        ...(ref === undefined
          ? {}
          : {
              reference: {
                length: ref.length,
                sha256: createHash("sha256").update(ref).digest("hex").slice(0, 16),
              },
            }),
        verdicts,
        body: mask(trace.body).slice(0, 8_192),
      };
    }),
  );
};

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
  h.fixture.prepareAcquisition(pool.id, id, "codex");
  // Shared from the start, so a member can later see its usage; a personal account can't be shared.
  const pending = yield* h.request(
    "POST",
    `${h.appPath(pool.id)}/accounts/app/subscriptions/connections`,
    { destination: { kind: "shared", audience: { kind: "everyone" } } },
  );
  const connection = `${h.prefix}/connections/${pending.id}/interactive`;
  yield* h.request("POST", `${connection}/start`, { method: "loginFile" });
  const saved = yield* h.request("POST", `${connection}/submit`, {
    value: JSON.stringify({ type: "codex", refresh_token: "synthetic-never-outbound" }),
  });
  checked("the synthetic account saves through the real host", saved.state, "connected");
  const account = `${h.prefix}/accounts/${saved.account.id}`;
  const resets = `${h.prefix}/pools/${pool.id}/accounts/${saved.account.id}`;
  // Five credits, so each journey below has one to spend.
  h.fixture.seedReset(pool.id, id, "codex", 5);
  yield* h.request("PATCH", account, { label });
  // The same call the account row's Refresh makes (refreshAccountObservationsAtom).
  diagnostics.refreshed = yield* h.request("POST", `${account}/observations/refresh`);
  diagnostics.seededResets = h.fixture.resets.balances(id);
  yield* until(
    h.request("GET", `${account}/observations`).pipe(
      Effect.tap((view) =>
        Effect.sync(() => {
          diagnostics.lastObservations = view;
        }),
      ),
    ),
    (view) =>
      view.reports.some((report) =>
        report.result?.observation.balances.some((balance) => balance.unit === "resets"),
      ),
    "the account's reading has no banked resets",
  ).pipe(
    Effect.tapError(() =>
      Effect.promise(() =>
        diagnosePool(h.fixture.traces).then((pool) => {
          diagnostics.pool = pool;
        }),
      ),
    ),
  );
  const consumes = () => h.fixture.resets.calls.filter((call) => call.action === "consume");

  const browser = yield* Effect.acquireRelease(
    Effect.promise(() => chromium.launch({ headless: true })),
    (browser) => Effect.promise(() => browser.close()),
  );
  const open = (role) =>
    Effect.gen(function* () {
      const context = yield* Effect.promise(() => browser.newContext());
      const cookies = Redacted.value(yield* h.actors[role].cookies);
      yield* Effect.promise(() => context.addCookies([...cookies]));
      return yield* Effect.promise(() => context.newPage());
    });
  const accounts = `${h.origin}/org/${h.actors.organization.slug}/accounts`;
  const owner = yield* open("owner");
  const control = owner.locator("[data-reset-control]");
  const confirm = owner.locator("[data-reset-confirm]");
  const note = (kind) => owner.locator(`[data-reset-note="${kind}"]`);
  const load = () => owner.goto(accounts).then(() => control.waitFor());
  const shot = (name) => owner.screenshot({ path: join(directory, `${name}.png`) });
  const cancelFocused = () =>
    owner.evaluate(() => document.activeElement?.hasAttribute("data-reset-cancel") === true);

  // Opening reads the catalog and the attempt; it never spends. Cancel takes focus.
  // Which binding the row's reset control would act through: a pool, usable, created by the viewer.
  const rows = yield* h.request("GET", `${h.prefix}/resources/accounts`);
  const row = (Array.isArray(rows) ? rows : (rows?.accounts ?? rows?.rows ?? [])).find(
    (entry) => entry?.id === saved.account.id,
  );
  diagnostics.resetBinding = {
    viewerIsUser: typeof identity?.user?.id === "string",
    rowFound: row !== undefined,
    bindings: (row?.bindings ?? []).map((binding) => ({
      pool: binding.pool === undefined ? "none" : binding.pool === pool.id ? "this pool" : "other",
      canUse: binding.access?.canUse,
      creatorIsViewer: binding.access?.creator === identity?.user?.id,
    })),
  };
  yield* page(() =>
    load()
      .then(() => shot("reset-idle"))
      .catch((error) => shot("reset-missing").then(() => Promise.reject(error))),
  );
  checked("loading the row spends nothing", consumes().length, 0);
  yield* page(() => control.click().then(() => confirm.waitFor()));
  checked("Cancel takes focus in the confirm", yield* page(cancelFocused), true);
  checked(
    "the confirm names spending one of the usable credits",
    (yield* page(() => confirm.innerText())).includes("1 of 5"),
    true,
  );
  checked(
    "a Codex credit never claims it applies now",
    yield* page(() => confirm.locator("[data-reset-applies]").innerText()),
    "Codex hasn't said whether it applies now.",
  );
  yield* page(() => shot("reset-confirm"));
  yield* page(() =>
    owner.keyboard.press("Enter").then(() => confirm.waitFor({ state: "detached" })),
  );
  checked("Enter on the focused Cancel spends nothing", consumes().length, 0);
  yield* page(() => control.click().then(() => confirm.waitFor()));
  yield* page(() =>
    owner.keyboard.press("Escape").then(() => confirm.waitFor({ state: "detached" })),
  );
  checked("Escape closes the confirm without spending", consumes().length, 0);

  // Use reset: one spend, then "confirmed" with no decrement until fresh usage arrives.
  yield* page(() =>
    control
      .click()
      .then(() => confirm.getByRole("button", { name: "Use reset", exact: true }).click())
      .then(() => note("confirmed").waitFor()),
  );
  checked("Use reset spends exactly once", consumes().length, 1);
  checked(
    "the confirmed control stays disabled",
    yield* page(() => control.getAttribute("data-reset-control")),
    "confirmed",
  );
  checked(
    "the count is not decremented locally",
    yield* page(() => control.getAttribute("data-reset-count")),
    "5",
  );
  yield* page(() => shot("reset-confirmed"));

  // A definite refusal shows its reason and spends nothing.
  h.fixture.resets.mode(id, "refused");
  yield* page(() =>
    load()
      .then(() => control.click())
      .then(() => confirm.getByRole("button", { name: "Use reset", exact: true }).click())
      .then(() => note("refused").waitFor()),
  );
  checked(
    "a refusal names the provider's answer",
    (yield* page(() => note("refused").innerText())).includes("nothing to reset"),
    true,
  );
  checked(
    "the refusal reached the provider once and spent nothing",
    h.fixture.resets.remaining(id),
    4,
  );
  yield* page(() => shot("reset-refused"));
  yield* page(() => note("refused").getByRole("button", { name: "Dismiss" }).click());

  // The POST is dropped before the server records it. The tab keeps its IDs across a reload, and
  // Retry sends that same request once the connection works: one spend, never a second UUID.
  h.fixture.resets.mode(id, "reset");
  const isSpend = (url) => url.pathname.endsWith("/reset");
  const drop = (route) =>
    route.request().method() === "POST" ? route.abort("connectionreset") : route.continue();
  const beforeDrop = consumes().length;
  yield* page(() =>
    owner
      .route(isSpend, drop)
      .then(() => control.click())
      .then(() => confirm.getByRole("button", { name: "Use reset", exact: true }).click())
      .then(() => note("unrecorded").waitFor()),
  );
  const dropped = yield* page(() => note("unrecorded").getAttribute("data-request-id"));
  checked("a dropped POST reaches no provider", consumes().length, beforeDrop);
  checked(
    "a dropped POST blocks a new spend",
    yield* page(() => control.getAttribute("data-reset-control")),
    "unrecorded",
  );
  yield* page(() => shot("reset-unrecorded"));
  yield* page(() => owner.reload().then(() => note("unrecorded").waitFor()));
  checked(
    "a reload keeps the dropped request's ID",
    yield* page(() => note("unrecorded").getAttribute("data-request-id")),
    dropped,
  );
  yield* page(() =>
    owner
      .unroute(isSpend, drop)
      .then(() => note("unrecorded").getByRole("button", { name: "Retry", exact: true }).click())
      .then(() => confirm.waitFor()),
  );
  checked(
    "Cancel takes focus before replaying a dropped request",
    yield* page(cancelFocused),
    true,
  );
  checked("opening that confirm sends nothing", consumes().length, beforeDrop);
  yield* page(() =>
    confirm
      .getByRole("button", { name: "Retry", exact: true })
      .click()
      .then(() => note("confirmed").waitFor()),
  );
  checked("the replay of a dropped request spends once", consumes().length, beforeDrop + 1);
  checked("the replay keeps the dropped request's ID", consumes().at(-1).requestId, dropped);
  checked("the dropped request spent one credit", h.fixture.resets.remaining(id), 3);

  // A lost answer is unknown; a reload restores the same request, and Retry replays it exactly.
  h.fixture.resets.mode(id, "unknown");
  const held = h.fixture.resets.hold();
  yield* page(() =>
    load()
      .then(() => control.click())
      .then(() => confirm.getByRole("button", { name: "Use reset", exact: true }).click()),
  );
  yield* Effect.promise(() => held.started);
  yield* page(() => note("pending").waitFor());
  checked(
    "the control is disabled while pending",
    yield* page(() => control.getAttribute("data-reset-control")),
    "pending",
  );
  held.release();
  yield* page(() => note("unknown").waitFor());
  const lost = consumes().at(-1);
  checked(
    "the unknown note keeps the spend's request ID",
    yield* page(() => note("unknown").getAttribute("data-request-id")),
    lost.requestId,
  );
  yield* page(() => shot("reset-unknown"));
  h.fixture.restart();
  yield* page(() => owner.reload().then(() => note("unknown").waitFor()));
  checked(
    "a reload recovers the same request from the server",
    yield* page(() => note("unknown").getAttribute("data-request-id")),
    lost.requestId,
  );
  checked(
    "a retained unknown disables new spends",
    yield* page(() => control.getAttribute("data-reset-control")),
    "unknown",
  );
  const spent = consumes().length;
  yield* page(() =>
    note("unknown")
      .getByRole("button", { name: "Retry", exact: true })
      .click()
      .then(() => confirm.waitFor()),
  );
  checked("Cancel takes focus before a retry", yield* page(cancelFocused), true);
  checked("opening the retry confirm sends nothing", consumes().length, spent);
  yield* page(() =>
    confirm
      .getByRole("button", { name: "Retry", exact: true })
      .click()
      .then(() => note("confirmed").waitFor()),
  );
  const replay = consumes().at(-1);
  checked("the retry reuses the request ID", replay.requestId, lost.requestId);
  checked("the retry reuses the credit ID", replay.creditId, lost.creditId);
  checked("the replay spent no second credit", h.fixture.resets.remaining(id), 2);

  // Past the server's retry window, the retained unknown blocks a new spend and offers no retry.
  yield* page(() =>
    load()
      .then(() => control.click())
      .then(() => confirm.getByRole("button", { name: "Use reset", exact: true }).click())
      .then(() => note("unknown").waitFor()),
  );
  h.fixture.advance(10 * 60_000);
  h.fixture.restart();
  yield* page(() => owner.reload().then(() => note("unknown").waitFor()));
  checked(
    "an expired unknown offers no retry",
    yield* page(() => note("unknown").getByRole("button", { name: "Retry" }).count()),
    0,
  );
  checked(
    "an expired unknown explains why nothing more is sent",
    (yield* page(() => note("unknown").innerText())).includes("retry window ended"),
    true,
  );
  const blocked = consumes().length;
  yield* page(() => control.click({ force: true }));
  checked("clicking the blocked control opens no confirm", yield* page(() => confirm.count()), 0);
  checked("the blocked control spends nothing", consumes().length, blocked);
  checked(
    "the server also refuses a new request ID",
    (yield* h.raw("owner", "POST", `${resets}/reset`, {
      creditId: "synthetic-credit-5",
      requestId: crypto.randomUUID(),
    })).status,
    409,
  );
  yield* page(() => shot("reset-blocked"));

  // The owner shares the account's usage, so a member sees the cells and the count. The member
  // doesn't own the pool, so the count stays read-only and no provider is reached.
  const policy = yield* h.request("GET", `${account}/observations/access`);
  yield* h.request("PUT", `${account}/observations/access`, {
    ...policy,
    read: { kind: "everyone" },
  });
  const calls = h.fixture.resets.calls.length;
  const member = yield* open("member");
  // What the member's own reads see, kept for failure.json if the count never shows.
  const memberView = yield* h
    .requestAs("member", "GET", `${account}/observations`)
    .pipe(Effect.result);
  diagnostics.memberObservations =
    memberView._tag === "Success"
      ? {
          canInspect: memberView.success?.canInspect,
          reports: (memberView.success?.reports ?? []).map((report) => ({
            outcome: report.lastAttempt?.outcome,
            hasResult: report.result != null,
            balances: report.result?.observation?.balances?.length ?? 0,
            windows: report.result?.observation?.windows?.length ?? 0,
          })),
        }
      : { error: String(memberView.failure).slice(0, 300) };
  yield* page(() =>
    member
      .goto(accounts)
      .then(() => member.locator("[data-reset-count]").first().waitFor())
      .catch((error) =>
        member
          .screenshot({ path: join(directory, "member-missing.png") })
          .then(() => Promise.reject(error)),
      ),
  );
  checked(
    "a member who sees the usage cells sees no reset control",
    yield* page(() =>
      Promise.all([
        member.locator("[data-reset-control]").count(),
        member.locator("button[data-reset-count]").count(),
      ]),
    ),
    [0, 0],
  );
  checked("a member's view reaches no provider", h.fixture.resets.calls.length, calls);
  checked("only confirmed clicks spent", consumes().length, blocked);
  return { checks, syntheticOnly: true, runtimeDirectory: h.runtimeDirectory };
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
    JSON.stringify({ checks, message: String(error), diagnostics }, null, 2) + "\n",
    { mode: 0o600 },
  );
  throw error;
}
