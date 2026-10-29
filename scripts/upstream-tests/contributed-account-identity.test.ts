import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { appSource, contributedFixture } from "./contributed-accounts-fixture.ts";
import { params } from "./contributed-accounts-assertions.ts";
import { load, implementation } from "./pool-access-fixture.ts";

test("directory and inventory keep ordinary shared identity for app-only editors and holders, not viewers", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const { accountDestination, sharedAppCreation } = yield* Effect.promise(() =>
        load(`${implementation}resource-lifecycle.ts`),
      );
      const { applicationAccess, accountAccesses, currentResourceAuthority } =
        yield* Effect.promise(() => load(`${implementation}resource-policy.ts`));
      const editor = f.spare;
      const viewer = yield* f.signup("Viewer", "viewer@example.invalid");
      yield* Effect.promise(() =>
        f.auth.api.addMember({
          body: { organizationId: f.org.id, userId: viewer.id, role: "member" },
        }),
      );
      const { app } = yield* f.as(
        editor,
        f.executor.apps
          .deploy({
            owner: f.app.owner,
            name: "Member-managed app",
            files: [{ path: "index.ts", content: appSource }],
          })
          .pipe(sharedAppCreation),
      );
      const account = yield* f.as(
        f.guest,
        f.executor.managedAccounts
          .add({
            owner: app.owner,
            provider: app.requirements.accounts.normalTokens.provider,
            method: "token",
            label: "Team sandbox",
            fields: Redacted.make({ token: "fixture-token" }),
          })
          .pipe(accountDestination({ kind: "shared", audience: { kind: "everyone" } })),
      );
      yield* f.request(editor, "appLink", params(app, "normalTokens", account.id));
      yield* f.check(f.guest, account.id);
      const links = yield* f.sql`select subject from hosted_app_account_links
        where account = ${account.id}`;
      assert.deepEqual(links, [{ subject: null }], "only an app-scope link exists");
      const actor = yield* f.as(editor, currentResourceAuthority);
      assert.equal(actor.role, "member");
      assert.equal((yield* f.as(editor, applicationAccess(app.id, actor))).canManage, true);
      assert.equal((yield* f.as(editor, accountAccesses([account.id], actor)))[0].canManage, false);

      const { contributedHttp } = yield* Effect.promise(
        () => import("./contributed-accounts-http.ts"),
      );
      const http = yield* contributedHttp(f, "organization");
      for (const user of [viewer, f.guest, editor]) {
        for (const path of ["/resources?view=available", "/inventory"]) {
          const response = yield* http(user, "GET", path);
          const context = `${path} as ${user.name}`;
          assert.equal(response.status, 200, context);
          const body: any = yield* Effect.promise(() => response.json());
          const listed = body.accounts.find((entry: any) =>
            path.startsWith("/resources")
              ? entry.account.id === account.id
              : entry.id === account.id,
          );
          assert.ok(listed, context);
          const health = listed.health;
          assert.ok(health, context);
          assert.deepEqual(health.apps, [], `${context}: no user-scope checks`);
          if (user === viewer) {
            assert.equal(health.info, null, context);
            assert.equal(health.infoCheckedAt, null, context);
          } else {
            assert.deepEqual(
              health.info,
              {
                displayName: "Upstream person",
                email: "upstream@example.invalid",
                username: "upstream-user",
                avatarUrl: "https://example.invalid/avatar.png",
                profileUrl: "https://example.invalid/profile",
              },
              context,
            );
            assert.ok(health.infoCheckedAt, context);
          }
        }
      }
    }),
  );
});

test("ordinary shared account links, get and check hide identity from viewers and keep it for editors and holders", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const { accountDestination } = yield* Effect.promise(() =>
        load(`${implementation}resource-lifecycle.ts`),
      );
      // No interactive acquisition identity or contributed link exists for this account.
      const account = yield* f.as(
        f.guest,
        f.executor.managedAccounts
          .add({
            owner: f.app.owner,
            provider: f.app.requirements.accounts.normalTokens.provider,
            method: "token",
            label: "Sandbox writes",
            description: "Use for destructive tests only",
            fields: Redacted.make({ token: "fixture-token" }),
          })
          .pipe(accountDestination({ kind: "shared", audience: { kind: "everyone" } })),
      );
      yield* f.request(f.owner, "appLink", params(f.app, "normalTokens", account.id));
      yield* f.check(f.owner, account.id);
      const { contributedHttp } = yield* Effect.promise(
        () => import("./contributed-accounts-http.ts"),
      );
      const http = yield* contributedHttp(f);
      for (const user of [f.spare, f.owner, f.guest]) {
        const response = yield* http(user, "GET");
        assert.equal(response.status, 200);
        const links: any = yield* Effect.promise(() => response.json());
        const link = links.find((entry: any) => entry.account.id === account.id);
        const get = yield* f.account(user, account.id);
        const checked = yield* f.check(user, account.id);
        for (const metadata of [link.account, get.account]) {
          assert.equal(metadata.label, "Sandbox writes");
          assert.equal(metadata.description, "Use for destructive tests only");
        }
        for (const [path, health] of [
          ["appList", link.health],
          ["get", get.health],
          ["check", checked],
        ] as const) {
          const context = `${path} as ${user.name}`;
          assert.ok(health.apps.length > 0, context);
          assert.equal(health.apps[0].check.displayStatus.meters[0].remaining, 0.75, context);
          if (user === f.spare) {
            assert.equal(health.info, null, context);
            assert.equal(health.infoCheckedAt, null, context);
            assert.deepEqual(
              health.apps[0].check.displayStatus.badges.map((badge: any) => badge.label),
              ["Available"],
              context,
            );
          } else {
            assert.deepEqual(
              health.info,
              {
                displayName: "Upstream person",
                email: "upstream@example.invalid",
                username: "upstream-user",
                avatarUrl: "https://example.invalid/avatar.png",
                profileUrl: "https://example.invalid/profile",
              },
              context,
            );
            assert.ok(health.infoCheckedAt, context);
            assert.deepEqual(
              health.apps[0].check.displayStatus.badges.map((badge: any) => badge.label),
              ["Pro plan", "Available"],
              context,
            );
          }
        }
      }
    }),
  );
});

test("acquisition identity reads stay within the owner and requested accounts and have an index", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const account = yield* f.connect(f.guest);
      // Malformed identity outside either boundary must never reach the decoder.
      yield* f.sql`insert into executor_account_connections
        (id, owner, provider, reconnect_account, state, revision, oauth_attempt, created_at, expires_at, target)
        select id || '-foreign', 'organization:other', provider, null,
          jsonb_set(state::jsonb, '{interactive,accountInfo}', '"invalid"'::jsonb),
          revision, null, created_at, expires_at, target
        from executor_account_connections where state::jsonb -> 'account' ->> 'id' = ${account.id}`;
      yield* f.sql`insert into executor_account_connections
        (id, owner, provider, reconnect_account, state, revision, oauth_attempt, created_at, expires_at, target)
        select id || '-unrendered', owner, provider, null,
          jsonb_set(jsonb_set(state::jsonb, '{account,id}', '"acc_unrendered"'::jsonb),
            '{interactive,accountInfo}', '"invalid"'::jsonb),
          revision, null, created_at, expires_at, target
        from executor_account_connections
        where owner = ${f.app.owner} and state::jsonb -> 'account' ->> 'id' = ${account.id}`;
      assert.equal(
        (yield* f.account(f.guest, account.id)).account.label,
        "upstream@example.invalid",
      );
      const [index] = yield* f.sql`select indexdef from pg_indexes
        where tablename = 'executor_account_connections' and indexname = 'hosted_account_connection_identity'`;
      assert.match(index.indexdef, /owner/);
      assert.match(index.indexdef, /account/);
      // The tiny fixture would otherwise choose a sequential scan regardless of index coverage.
      yield* f.sql.withTransaction(
        Effect.gen(function* () {
          yield* f.sql`set local enable_seqscan = off`;
          const plan = yield* f.sql`explain select c.state::jsonb -> 'interactive' -> 'accountInfo'
            from executor_account_connections c where c.owner = ${f.app.owner}
              and c.state::jsonb ->> 'status' = 'completed'
              and c.state::jsonb -> 'interactive' is not null
              and c.state::jsonb -> 'account' ->> 'id' in ${f.sql.in([account.id])}`;
          assert.match(JSON.stringify(plan), /hosted_account_connection_identity/);
          assert.match(JSON.stringify(plan), /Index Cond.*owner.*account/);
        }),
      );
    }),
  );
});

test("a contributed holder keeps their identity when the link was made by an editor", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const account = yield* f.connect(f.guest);
      yield* f.check(f.guest, account.id);
      yield* f.sql`update hosted_app_account_links set linked_by = ${f.owner.id}
        where account = ${account.id}`;
      const [holder] = yield* f.request(f.guest, "appList", { app: f.app.id });
      assert.equal(holder.health.info.email, "upstream@example.invalid");
      const [viewer] = yield* f.request(f.spare, "appList", { app: f.app.id });
      assert.equal(viewer.health.info, null);
      assert.equal(viewer.health.infoCheckedAt, null);
    }),
  );
});

test("stored contributed status notes are private to holders and editors across list, get and check", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const account = yield* f.connect(f.guest, "shared", {
        kind: "shared",
        audience: { kind: "everyone" },
      });
      yield* f.check(f.guest, account.id);
      const { contributedHttp } = yield* Effect.promise(
        () => import("./contributed-accounts-http.ts"),
      );
      const http = yield* contributedHttp(f);
      for (const user of [f.spare, f.guest, f.owner]) {
        const response = yield* http(user, "GET");
        assert.equal(response.status, 200);
        const links: any = yield* Effect.promise(() => response.json());
        const link = links.find((entry: any) => entry.account.id === account.id);
        const get = yield* f.account(user, account.id);
        const checked = yield* f.check(user, account.id);
        for (const [path, health] of [
          ["appList", link.health],
          ["get", get.health],
          ["check", checked],
        ] as const) {
          const context = `${path} as ${user.name}`;
          assert.ok(health.apps.length > 0, context);
          const status = health.apps[0].check.displayStatus;
          assert.deepEqual(status.meters, [{ label: "5 hours", remaining: 0.75 }], context);
          const sharedStat = { label: "Requests", value: "42", identity: false };
          if (user === f.spare) {
            assert.equal(health.info, null, context);
            assert.equal(health.infoCheckedAt, null, context);
            assert.deepEqual(status.stats, [sharedStat], context);
            assert.deepEqual(
              status.badges,
              [{ label: "Available", tone: "good", identity: false }],
              context,
            );
          } else {
            assert.equal(health.info.email, "upstream@example.invalid", context);
            assert.deepEqual(
              status.stats,
              [
                { label: "Note", value: "Sign in again as alice@example.invalid" },
                { label: "Plan", value: "Personal plan", identity: true },
                sharedStat,
              ],
              context,
            );
            assert.deepEqual(
              status.badges.map((badge: any) => badge.label),
              ["Pro plan", "Available"],
              context,
            );
          }
        }
      }
    }),
  );
});
