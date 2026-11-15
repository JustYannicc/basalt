import assert from "node:assert/strict";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { roleHost } from "../../.upstream/e2e/support/role-hosts.ts";
import { batchedReads, batchPath } from "../../.upstream/e2e/support/read-batches.ts";

/** Real hosted counter writes and authorized browser reads, including the former idle timers. */
export const accountTrafficProof = ({
  h,
  database,
  browser,
  pool,
  saved,
  check,
  diagnostics,
  directory,
}) =>
  Effect.gen(function* () {
    const origin = roleHost(h.origin, "app");
    const appPath = h.appPath(pool.id);
    const scope = `organization:${h.actors.organization.id}`;
    const run = (work) => Effect.promise(work).pipe(Effect.timeout("30 seconds"));
    const published = () => h.request("PATCH", `${h.prefix}/accounts/${saved.account.id}`, {});
    diagnostics.accountTraffic = [];
    for (const width of [1280, 390]) {
      const context = yield* Effect.acquireRelease(
        Effect.promise(() =>
          browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true }),
        ),
        (context) => Effect.promise(() => context.close()),
      );
      const cookies = Redacted.value(yield* h.actors.owner.cookies);
      yield* run(() => context.addCookies([...cookies]));
      const page = yield* run(() => context.newPage());
      const counts = { traffic: 0, app: 0, user: 0 };
      const timeline = [];
      const isCurrent = (request) =>
        new URL(request.url()).pathname === `${h.prefix}/changes/current`;
      const active = new Set(),
        waiters = new Set();
      const kinds = (request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() === "POST" && path === `${h.prefix}/account-traffic`)
          return ["traffic"];
        if (request.method() === "POST" && path === batchPath)
          return batchedReads(request.postData()).flatMap((read) =>
            read.group === "apps" && read.endpoint === "get"
              ? ["app"]
              : read.group === "appAccounts" && read.endpoint === "userList"
                ? ["user"]
                : [],
          );
        if (request.method() !== "GET") return [];
        if (path === appPath) return ["app"];
        if (path === `${appPath}/accounts/user`) return ["user"];
        return [];
      };
      page.on("request", (request) => {
        const names = kinds(request);
        if (names.length || isCurrent(request)) {
          timeline.push({ event: "request", at: Date.now(), names, current: isCurrent(request) });
          for (const name of names) counts[name]++;
          active.add(request);
        }
      });
      page.on("response", (response) => {
        const names = kinds(response.request());
        if (names.length)
          timeline.push({
            event: "body-response",
            at: Date.now(),
            names,
            status: response.status(),
          });
        if (!isCurrent(response.request())) return;
        void response.json().then(
          (body) => timeline.push({ event: "heads", at: Date.now(), revisions: body.revisions }),
          () => timeline.push({ event: "head-failure", at: Date.now(), status: response.status() }),
        );
      });
      const finished = (request) => {
        active.delete(request);
        if (active.size) return;
        for (const resolve of waiters) resolve();
        waiters.clear();
      };
      page.on("requestfinished", finished);
      page.on("requestfailed", finished);
      const idle = () =>
        active.size ? new Promise((resolve) => waiters.add(resolve)) : Promise.resolve();
      const flush = async () => {
        await page.clock.runFor(250);
        await idle();
        await Promise.all([
          page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          ),
          page.clock.runFor(80),
        ]);
      };
      const firstTraffic = Promise.allSettled([
        page.waitForResponse(
          (response) => response.status() === 200 && kinds(response.request()).includes("traffic"),
        ),
      ]);
      yield* run(async () => {
        await page.clock.install();
        await page.goto(
          `${origin}/org/${h.actors.organization.slug}/apps/${pool.id}?view=accounts`,
        );
        await page.getByText("Account selection", { exact: true }).waitFor();
        await page.getByRole("region", { name: "App accounts", exact: true }).waitFor();
        const [first] = await firstTraffic;
        if (first.status === "rejected") throw first.reason;
        await first.value.json();
        await idle();
        await flush();
      });
      const initial = { ...counts };
      const progress = { width, counts, initial, timeline, phase: "idle" };
      diagnostics.accountTraffic.push(progress);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          if (progress.phase !== "complete" && !page.isClosed())
            await page.screenshot({
              path: join(directory, `traffic-${width}-failure.png`),
              fullPage: true,
            });
        }),
      );
      assert.ok(initial.traffic > 0, "the real Accounts tab loads tool-call traffic");
      yield* run(() => page.clock.runFor(31_000).then(flush));
      check(`Account detail at ${width}: healthy idle makes zero body reads`, counts, initial);
      timeline.push({ event: "idle-proved", at: Date.now(), counts: { ...counts } });

      const detailBefore = { ...counts };
      progress.phase = "rename";
      const detailResponses = Promise.allSettled(
        ["app", "user"].map((name) =>
          page.waitForResponse(
            (response) => response.status() === 200 && kinds(response.request()).includes(name),
          ),
        ),
      );
      const name = `Synthetic traffic pool ${width}`;
      yield* h.request("PATCH", `${appPath}/name`, { name });
      progress.phase = "rename-responses";
      yield* run(() => page.clock.runFor(5));
      for (const result of yield* run(() => detailResponses))
        if (result.status === "rejected") throw result.reason;
      progress.phase = "rename-render";
      yield* run(() =>
        page
          .locator("header h1")
          .getByRole("link", { name: `${name} overview`, exact: true })
          .waitFor(),
      );
      progress.phase = "rename-idle";
      yield* run(flush);
      check(
        `Account detail at ${width}: committed app change refreshes app and links once`,
        counts,
        { ...detailBefore, app: detailBefore.app + 1, user: detailBefore.user + 1 },
      );
      const detailAccepted = { ...counts };
      yield* h.request("PATCH", `${appPath}/name`, { name });
      yield* run(() => page.clock.runFor(6_100).then(flush));
      check(
        `Account detail at ${width}: no-op app change causes zero reads`,
        counts,
        detailAccepted,
      );

      const trafficBefore = counts.traffic;
      progress.phase = "counter";
      const answered = Promise.allSettled([
        page.waitForResponse(
          (response) => kinds(response.request()).includes("traffic") && response.status() === 200,
        ),
      ]);
      yield* database.run({
        sql: `insert into executor_account_tool_calls(account,hour,requests,failed,last_success)
          values($1,date_trunc('hour',now()),1,0,now())
          on conflict(account,hour) do update set requests=executor_account_tool_calls.requests+1,
            last_success=excluded.last_success`,
        params: [saved.account.id],
      });
      yield* published();
      const [answer] = yield* run(() => answered);
      if (answer.status === "rejected") throw answer.reason;
      const response = answer.value;
      const body = yield* run(() => response.json());
      assert.ok(body.accounts.some((row) => row.account === saved.account.id && row.requests > 0));
      yield* run(flush);
      check(
        `Account traffic at ${width}: a committed counter refreshes exactly once`,
        counts.traffic - trafficBefore,
        1,
      );
      const accepted = counts.traffic;
      progress.phase = "rollback";
      const current = `${h.prefix}/changes/current?account=${saved.account.id}`;
      const before = yield* h.request("GET", current);
      yield* database.run({
        sql: `do $rollback$ begin
          update executor_account_tool_calls set requests=requests+1
            where account=convert_from(decode('${Buffer.from(saved.account.id).toString("hex")}','hex'),'UTF8');
          raise exception using errcode='ZX001';
          exception when sqlstate 'ZX001' then null;
          end $rollback$`,
      });
      yield* database.run({
        sql: "update executor_account_tool_calls set requests=requests where account=$1",
        params: [saved.account.id],
      });
      yield* h.request("PATCH", `${h.prefix}/accounts/${saved.account.id}`, {
        label: `Synthetic traffic ${width}`,
      });
      yield* published();
      const after = yield* h.request("GET", current);
      check(
        `Account traffic at ${width}: rollback and no-op preserve the traffic revision`,
        after.revisions.filter(({ topic }) => topic === "account-traffic"),
        before.revisions.filter(({ topic }) => topic === "account-traffic"),
      );
      yield* run(() => page.clock.runFor(6_100).then(flush));
      check(
        `Account traffic at ${width}: rollback, no-op and foreign topic make zero reads`,
        counts.traffic,
        accepted,
      );
      const heads = yield* database.run({
        sql: "select revision::text from hosted_change_heads where scope=$1 and topic='account-traffic'",
        params: [scope],
      });
      assert.ok(heads.length > 0, "the counter's real owner scope has a committed traffic head");
      progress.phase = "complete";
      yield* run(() => page.goto("about:blank"));
    }
  });
