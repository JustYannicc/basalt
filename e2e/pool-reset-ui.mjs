// The banked reset control in a real browser against the hosted app and the synthetic pool
// fixture. Every provider reply is synthetic; no request leaves the fixture, and nothing spends
// without a click on "Use reset" or "Retry" inside the confirm.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
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
  const pending = yield* h.request(
    "POST",
    `${h.appPath(pool.id)}/accounts/app/subscriptions/connections`,
    {},
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
  yield* h.request("POST", `${account}/observations/refresh`);
  yield* until(
    h.request("GET", `${account}/observations`),
    (view) =>
      view.reports.some((report) =>
        report.result?.observation.balances.some((balance) => balance.unit === "resets"),
      ),
    "the account's reading has no banked resets",
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
  yield* page(() => load().then(() => shot("reset-idle")));
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

  // A lost answer is unknown; a reload restores the same request, and Retry replays it exactly.
  h.fixture.resets.mode(id, "unknown");
  const held = h.fixture.resets.hold();
  yield* page(() =>
    control
      .click()
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
  checked("the replay spent no second credit", h.fixture.resets.remaining(id), 3);

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

  // A member without authority over the owner's pool sees no control and reaches no provider.
  const calls = h.fixture.resets.calls.length;
  const member = yield* open("member");
  yield* page(() => member.goto(accounts).then(() => member.waitForLoadState("networkidle")));
  checked(
    "a member sees no reset control",
    yield* page(() => member.locator("[data-reset-control]").count()),
    0,
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
    JSON.stringify({ checks, message: String(error) }, null, 2) + "\n",
    { mode: 0o600 },
  );
  throw error;
}
