import assert from "node:assert/strict";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { roleHost } from "../../.upstream/e2e/support/role-hosts.ts";
import { appsManifest } from "../../.upstream/e2e/support/apps-release.ts";
import { accountRow } from "../../.upstream/e2e/support/account-rows.ts";
import {
  bringRetriesForward,
  bringRolloutsForward,
  changeOutboxEmpty,
  openCatalogSweeps,
  openRollouts,
  provisioningJobs,
  provisioningMoved,
  provisioningSettled,
} from "./provisioning-diagnostics.mjs";

// Red switches for this proof only, read nowhere else. HOLD keeps the organization row lock that
// member setup takes from before the invitation is accepted until the measurement starts, so the
// new member's setup commits land right where A's heads are measured. SETTLE=0 measures without
// waiting for the organization's provisioning, as this proof did before.
const holdSetup = process.env.BASALT_E2E_PRIVACY_HOLD_SETUP === "1";
const settleFirst = process.env.BASALT_E2E_PRIVACY_SETTLE !== "0";

const source = `import { defineApp, defineProvider, secrets, object, string, router, query, accountRouter } from "apps";
const service = defineProvider({ name: "Private traffic fixture", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service: service.many() } } }, async ({ user, signal }) => ({
  tools: await accountRouter(user?.accounts.service ?? [], () => router({
    ping: query({ input: object({}) }, async () => true)
  }), { signal })
}));`;

/** Repeat a check every 250 ms until it answers true, failing with its message after 180 s. */
const untilDeadline = (check, message, deadlineMs = 180_000) =>
  Effect.gen(function* () {
    const end = Date.now() + deadlineMs;
    while (Date.now() < end) {
      if (yield* check) return;
      yield* Effect.sleep("250 millis");
    }
    return yield* Effect.fail(new Error(message()));
  });

/** Both actors are ordinary members; only B's real tool call may refresh B's private traffic. */
export const accountTrafficPrivacyProof = ({
  h,
  database,
  browser,
  check,
  diagnostics,
  directory,
}) =>
  Effect.gen(function* () {
    const run = (work) => Effect.promise(work).pipe(Effect.timeout("30 seconds"));
    const progress = { phase: "membership", viewers: [], holdSetup, settleFirst };
    diagnostics.privateTraffic = progress;
    const organization = h.actors.organization.id;
    // A release queues one delayed rollout per organization. It takes the organization's locks, so
    // it runs now, before the invitation, the held setup lock and the measurement, never inside them.
    progress.phase = "rollouts";
    // A stack that declares no repository service can't finish a catalog sweep; any other waits.
    const repositoryService = h.services?.repository !== false;
    yield* bringRolloutsForward(database, organization);
    yield* untilDeadline(
      Effect.gen(function* () {
        const jobs = yield* provisioningJobs(database, organization);
        progress.rollouts = openRollouts(jobs, { repositoryService });
        if (!repositoryService) progress.unprovedSweeps = openCatalogSweeps(jobs).length;
        if (progress.rollouts.length === 0) return true;
        yield* h.request("POST", "/api/onboarding/prepare", {});
        return false;
      }),
      () => `The organization's rollouts did not finish: ${JSON.stringify(progress.rollouts)}`,
    );
    if (!repositoryService) {
      const unproved = {
        proof: "The organization's rollouts finished",
        notWaitedFor: "catalog sweeps",
        open: progress.unprovedSweeps,
        reason: "no repository service in the local stack",
        issue: "#2122",
      };
      diagnostics.notProved = [...(diagnostics.notProved ?? []), unproved];
      console.log(`Not proved: ${JSON.stringify(unproved)}`);
    }
    progress.phase = "membership";
    if (holdSetup)
      yield* database.hold({
        sql: "select id from organization where id = $1 for no key update",
        params: [organization],
      });
    const identity = yield* h.requestAs("admin", "GET", "/api/auth/get-session");
    const invitation = yield* h.request("POST", "/api/auth/organization/invite-member", {
      organizationId: h.actors.organization.id,
      email: identity.user.email,
      role: "member",
    });
    yield* h.requestAs("admin", "POST", "/api/auth/organization/accept-invitation", {
      invitationId: invitation.id,
    });
    const app = yield* h.request("POST", `${h.prefix}/apps/deploy`, {
      name: "Private traffic proof",
      files: [{ path: "index.ts", content: source }, appsManifest],
    });
    const access = yield* h.request("GET", `${h.appPath(app.id)}/access`);
    yield* h.request("PATCH", `${h.appPath(app.id)}/access`, {
      revision: access.revision,
      audience: { kind: "everyone" },
    });
    const viewers = [];
    for (const [role, label] of [
      ["admin", "Private member A"],
      ["member", "Private member B"],
    ]) {
      progress.phase = `connect-${role}`;
      const connection = yield* h.requestAs(
        role,
        "POST",
        `${h.appPath(app.id)}/accounts/user/service/connections`,
        { destination: { kind: "personal" } },
      );
      const account = yield* h.requestAs(
        role,
        "POST",
        `${h.prefix}/connections/${connection.id}/submit`,
        {
          method: "key",
          label,
          fields: { token: "synthetic-private-traffic-key" },
        },
      );
      const call = () => h.callAs(role, app.id, "ping", { accountId: account.id, input: {} });
      const first = yield* call();
      assert.equal(first, true, "the private account's real tool call succeeds");
      const context = yield* Effect.acquireRelease(
        Effect.promise(() =>
          browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true }),
        ),
        (context) => Effect.promise(() => context.close()),
      );
      const cookies = Redacted.value(yield* h.actors[role].cookies);
      yield* run(() => context.addCookies([...cookies]));
      const page = yield* run(() => context.newPage());
      const state = { role, account: account.id, trafficReads: 0, current: undefined };
      progress.viewers.push(state);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (progress.phase !== "complete" && !page.isClosed())
            await page.screenshot({
              path: join(directory, `private-${role}-failure.png`),
              fullPage: true,
            });
        }),
      );
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === `${h.prefix}/account-traffic`
        )
          state.trafficReads++;
      });
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.pathname.endsWith("/changes/current") && url.searchParams.has("account"))
          state.current = response.url();
      });
      const cell = accountRow(page, label).locator("[data-account-requests]");
      progress.phase = `open-${role}`;
      yield* run(async () => {
        await page.clock.install();
        await page.goto(`${roleHost(h.origin, "app")}/org/${h.actors.organization.slug}/accounts`);
        await cell.getByText("1", { exact: true }).waitFor();
      });
      viewers.push({ page, context, state, cell, call });
    }
    const [a, b] = viewers;
    progress.phase = "private-call";
    assert.ok(
      a && b && a.state.current && b.state.current,
      "both real traffic feeds confirmed their selected accounts",
    );
    const flush = (page) =>
      Promise.all([
        page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        ),
        page.clock.runFor(250),
      ]);
    const heads = async (viewer) => {
      const response = await viewer.context.request.get(viewer.state.current);
      assert.equal(response.status(), 200);
      return (await response.json()).revisions;
    };
    // A new member's setup commits the organization's account and app heads after the invitation
    // is accepted, at times only on a retry. A's heads are measured once none of the organization's
    // provisioning waits or runs, so only B's tool call falls between the two readings.
    // A Cloud retry waits out its workflow's own backoff (5 s, doubling), so the bound is in time.
    const settleProvisioning = untilDeadline(
      Effect.gen(function* () {
        const jobs = yield* provisioningJobs(database, organization);
        progress.provisioning = jobs;
        if (provisioningSettled(jobs) && (yield* changeOutboxEmpty(database, organization)))
          return true;
        yield* bringRetriesForward(database, organization);
        // Each request delivers pending changes after it answers and dispatches what is due.
        yield* h.request("POST", "/api/onboarding/prepare", {});
        return false;
      }),
      () =>
        `The organization's provisioning did not settle: ${JSON.stringify(progress.provisioning)}`,
    );
    progress.phase = "settle";
    if (holdSetup) yield* database.release;
    if (settleFirst) yield* settleProvisioning;
    progress.phase = "private-measure";
    const openAtFirst = yield* provisioningJobs(database, organization);
    const before = { a: yield* run(() => heads(a)), b: yield* run(() => heads(b)) };
    assert.equal(
      before.a.some(({ resource }) => resource === b.state.account),
      false,
      "A's initial feed does not name B's private account",
    );
    assert.equal(
      yield* run(() =>
        a.page.getByRole("button", { name: "Manage Private member B", exact: true }).count(),
      ),
      0,
    );
    const baseline = { a: a.state.trafficReads, b: b.state.trafficReads };
    yield* run(() =>
      b.page.screenshot({ path: join(directory, "private-traffic-before.png"), fullPage: true }),
    );
    const refreshed = Promise.allSettled([
      b.page.waitForResponse(
        (response) =>
          response.status() === 200 &&
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === `${h.prefix}/account-traffic`,
      ),
    ]);
    assert.equal(yield* b.call(), true);
    const [answer] = yield* run(() => refreshed);
    if (answer.status === "rejected") throw answer.reason;
    const response = answer.value;
    const counted = yield* run(() => response.json());
    assert.equal(counted.accounts.find(({ account }) => account === b.state.account)?.requests, 2);
    yield* run(() => b.cell.getByText("2", { exact: true }).waitFor());
    const after = { a: yield* run(() => heads(a)), b: yield* run(() => heads(b)) };
    // A job that ran inside the measurement may have moved A's heads: the run is invalid, and says so.
    const moved = provisioningMoved(openAtFirst, yield* provisioningJobs(database, organization));
    if (settleFirst && moved.length > 0)
      return yield* Effect.fail(
        new Error(`Provisioning ran inside the private measurement: ${JSON.stringify(moved)}`),
      );
    yield* run(() => Promise.all(viewers.map(({ page }) => flush(page))));
    check(
      "private traffic: B's real tool call refreshes B exactly once",
      b.state.trafficReads - baseline.b,
      1,
    );
    check(
      "private traffic: A makes zero traffic reads for B's tool call",
      a.state.trafficReads - baseline.a,
      0,
    );
    check(
      "private traffic: A receives no new key or head for B's private account",
      after.a,
      before.a,
    );
    assert.equal(
      after.a.some(({ resource }) => resource === b.state.account),
      false,
    );
    const selected = (revisions) =>
      revisions.find(
        ({ topic, resource }) => topic === "account-traffic" && resource === b.state.account,
      )?.revision;
    check(
      "private traffic: only B's authorized account head advances",
      selected(after.b),
      String(BigInt(selected(before.b)) + 1n),
    );
    for (const suffix of ["", "/current"]) {
      const refused = yield* run(() =>
        a.context.request.get(
          `${roleHost(h.origin, "app")}${h.prefix}/changes${suffix}?account=${b.state.account}`,
        ),
      );
      check(
        `private traffic: A cannot guess B's key on ${suffix || "stream"}`,
        refused.status(),
        403,
      );
      assert.equal(yield* run(() => refused.text()), "");
    }
    diagnostics.privateTraffic = {
      baseline,
      afterReads: viewers.map(({ state }) => ({ ...state, current: undefined })),
      heads: { before, after },
      publicToolCalls: true,
    };
    yield* run(() =>
      b.page.screenshot({ path: join(directory, "private-traffic-after.png"), fullPage: true }),
    );
    yield* run(() => Promise.all(viewers.map(({ page }) => page.goto("about:blank"))));
    progress.phase = "complete";
  });
