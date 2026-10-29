import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted, Schema } from "effect";
import { contributedFixture } from "./contributed-accounts-fixture.ts";
import { load, implementation } from "./pool-access-fixture.ts";

import { forbidden, params } from "./contributed-accounts-assertions.ts";

test("members connect and link only contributed app requirements; link views name contributors and redact identity", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const { app, owner, guest, spare, connect, request, executor, as } = f;
      assert.equal(app.requirements.accounts.shared.contributed, true);
      assert.equal(app.requirements.accounts.ordinary.contributed, false);
      const account = yield* connect(guest);
      yield* forbidden(connect(guest, "ordinary"));
      yield* request(guest, "appUnlink", params(app, "shared", account.id));
      assert.equal(f.removals(), 1, "unlink runs the real app remove handler");
      const another = yield* connect(guest);
      const token = yield* f.token(guest);
      const saved = token.account ?? token;
      assert.ok(saved.id, JSON.stringify(token));
      yield* request(guest, "appUnlink", params(app, "tokens", saved.id));
      const linked = yield* request(guest, "appLink", params(app, "tokens", saved.id));
      assert.equal(linked.linkedBy.id, guest.id);
      yield* forbidden(request(guest, "appLink", params(app, "normalTokens", saved.id)));
      const checked = yield* as(
        guest,
        executor.accounts.check({ owner: app.owner, account: another.id, apps: [app.id] }),
      );
      assert.ok(checked.apps[0].check.displayStatus, JSON.stringify(checked));
      const holder = yield* request(guest, "appList", { app: app.id });
      const editor = yield* request(owner, "appList", { app: app.id });
      const viewer = yield* request(spare, "appList", { app: app.id });
      for (const list of [holder, editor, viewer]) {
        const link = list.find((l: any) => l.account.id === another.id);
        assert.deepEqual(link.linkedBy, { id: guest.id, name: guest.name });
      }
      assert.equal(holder.find((l: any) => l.account.id === another.id).canRemove, true);
      assert.equal(editor.find((l: any) => l.account.id === another.id).canRemove, true);
      const hidden = viewer.find((l: any) => l.account.id === another.id);
      assert.equal(hidden.canRemove, false);
      assert.equal(hidden.account.label, "Connected account");
      assert.equal(
        holder.find((l: any) => l.account.id === another.id).account.label,
        "upstream@example.invalid",
      );
      assert.equal(hidden.health.info, null);
      assert.equal(hidden.health.infoCheckedAt, null);
      assert.deepEqual(hidden.health.apps[0].check.displayStatus.badges, [
        { label: "Available", tone: "good", identity: false },
      ]);
      assert.deepEqual(hidden.health.apps[0].check.displayStatus.meters, [
        { label: "5 hours", remaining: 0.75 },
      ]);
      assert.equal(hidden.health.apps[0].check.status, "healthy");
      for (const list of [holder, editor]) {
        const visible = list.find((l: any) => l.account.id === another.id);
        assert.equal(visible.health.info.email, "upstream@example.invalid");
        assert.equal(visible.health.apps[0].check.displayStatus.badges[0].label, "Pro plan");
      }
      assert.equal((yield* request(guest, "appGet", params(app, "shared"))).canContribute, true);
      yield* forbidden(request(guest, "appGet", params(app, "ordinary")));
      yield* forbidden(request(spare, "appUnlink", params(app, "shared", another.id)));
      assert.equal(f.removals(), 1, "refused unlink never invokes remove");
      yield* request(owner, "appUnlink", params(app, "shared", another.id));
      assert.equal(f.removals(), 2, "an editor retires another member's contribution");
      // A token may use the app without access to someone else's personal account.
      yield* forbidden(request(spare, "appLink", params(app, "tokens", saved.id)));
    }),
  );
});

test("deleting a holder's linked acquired account runs remove first and preserves a failed removal", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const account = yield* f.connect(f.guest);
      f.failRemove();
      const failed = yield* Effect.exit(f.removeAccount(f.guest, account.id));
      assert.equal(failed._tag, "Failure");
      assert.equal(f.removals(), 0);
      assert.equal((yield* f.request(f.guest, "appList", { app: f.app.id })).length, 1);
      f.recoverRemove();
      yield* f.removeAccount(f.guest, account.id);
      assert.equal(f.removals(), 1);
      assert.equal((yield* f.request(f.owner, "appList", { app: f.app.id })).length, 0);
    }),
  );
});

test("contributed routes return real HTTP 403 responses and encode link attribution under signed-in sessions", async () => {
  const { contributedHttp } = await import("./contributed-accounts-http.ts");
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const http = yield* contributedHttp(f);
      const connected = yield* http(f.guest, "POST", "/shared/connections", {});
      assert.equal(
        connected.status,
        200,
        (yield* Effect.promise(() => connected.clone().text())) as string,
      );
      const denied = yield* http(f.guest, "POST", "/ordinary/connections", {});
      assert.equal(denied.status, 403);
      const account = yield* f.connect(f.guest);
      const listed = yield* http(f.spare, "GET");
      assert.equal(listed.status, 200);
      const links: any = yield* Effect.promise(() => listed.json());
      assert.deepEqual(links[0].linkedBy, { id: f.guest.id, name: f.guest.name });
      assert.equal(links[0].canRemove, false);
      assert.equal((yield* http(f.spare, "DELETE", `/shared/${account.id}`)).status, 403);
      assert.equal((yield* http(f.guest, "PUT", `/ordinary/${account.id}`)).status, 403);
      assert.equal((yield* http(f.guest, "DELETE", `/shared/${account.id}`)).status, 200);
    }),
  );
});

test("the account-status endpoint redacts shared-account identity for non-holders but keeps usage and availability", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const account = yield* f.connect(f.guest);
      yield* f.check(f.guest, account.id);
      // Explicitly sharing credentials permits use, but does not make another person their holder.
      yield* f.sql`update hosted_account_access set kind = 'shared', personal_user_id = null, audience = 'everyone' where account_id = ${account.id}`;
      const viewer = yield* f.account(f.spare, account.id);
      assert.equal(viewer.health.info, null);
      assert.deepEqual(
        viewer.health.apps[0].check.displayStatus.badges.map((b: any) => b.label),
        ["Available"],
      );
      assert.equal(viewer.health.apps[0].check.displayStatus.meters[0].remaining, 0.75);
      const refreshed = yield* f.check(f.spare, account.id);
      assert.equal(refreshed.info, null);
      assert.deepEqual(
        refreshed.apps[0].check.displayStatus.badges.map((b: any) => b.label),
        ["Available"],
      );
      for (const user of [f.guest, f.owner]) {
        const allowed = yield* f.account(user, account.id);
        assert.equal(allowed.health.info.email, "upstream@example.invalid");
        assert.equal(allowed.health.apps[0].check.displayStatus.badges[0].label, "Pro plan");
      }
      const requirement = yield* f.request(f.spare, "appGet", params(f.app, "shared"));
      assert.equal(requirement.accounts[0].account.label, "Connected account");
    }),
  );
});

test("contributed is opt-in, preserved beside cardinality, and rejected in user scope", async () => {
  const author = await load("packages/apps/src/index.ts");
  const { AccountRequirement } = await load("packages/sdk/src/core.ts");
  const p = author.defineProvider({
    name: "Fixture",
    auth: {
      token: author.secrets({ label: "Token", fields: author.object({ token: author.string() }) }),
    },
  });
  assert.throws(
    () => author.defineApp({ user: { accounts: { service: p.many().contributed() } } }, {}),
    /must be in app.accounts/,
  );
  const account = Schema.decodeUnknownSync(AccountRequirement)({
    scope: "app",
    provider: "prv_fixture",
    cardinality: "many",
    definition: { name: "Fixture", auth: {} },
  });
  assert.equal(account.contributed, false);
});

test("holders cannot delete someone else's contributed link; deleted contributors retain their id with a null name", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const account = yield* f.connect(f.guest);
      yield* f.sql`update hosted_app_account_links set linked_by = 'former-member' where account = ${account.id}`;
      const [visible] = yield* f.request(f.spare, "appList", { app: f.app.id });
      assert.deepEqual(visible.linkedBy, { id: "former-member", name: null });
      assert.equal(visible.canRemove, false);
      yield* forbidden(f.removeAccount(f.guest, account.id));
      assert.equal(f.removals(), 0);
      yield* f.request(f.owner, "appUnlink", params(f.app, "shared", account.id));
      assert.equal(f.removals(), 1);
    }),
  );
});

test("pending contributions recheck app access and the active requirement before any connect step", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const pending = yield* f.pending(f.guest, "shared");
      yield* f.sql`update hosted_app_access set audience = 'private' where id = ${f.app.id}`;
      yield* forbidden(f.start(f.guest, pending.id));
      yield* f.sql`update hosted_app_access set audience = 'everyone' where id = ${f.app.id}`;
      yield* f.sql`update executor_deployments set requirements = jsonb_set(requirements::jsonb, '{accounts,shared,contributed}', 'false'::jsonb) where id = ${f.app.activeVersion}`;
      yield* forbidden(f.start(f.guest, pending.id));
      const ownerPending = yield* f.pending(f.owner, "ordinary");
      yield* f.start(f.owner, ownerPending.id);
      assert.equal(f.removals(), 0);
    }),
  );
});

test("deploy rejects a hand-built contributed requirement with cardinality one", async () => {
  await assert.rejects(
    contributedFixture(() => Effect.void, { plainContribution: true }),
    /contributed requirement "shared" must be in app.accounts and have cardinality "many"/,
  );
});

test("ordinary shared metadata stays visible to users and managers; acquired labels respect typed renames", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const { inventory } = yield* Effect.promise(() => load(`${implementation}organization.ts`));
      const { resourceDirectory } = yield* Effect.promise(() =>
        load(`${implementation}resource-access.ts`),
      );
      const ordinary = yield* f.as(
        f.guest,
        f.executor.managedAccounts.add({
          owner: f.app.owner,
          provider: f.app.requirements.accounts.tokens.provider,
          method: "token",
          label: "Sandbox writes",
          description: "Use for destructive tests only",
          fields: Redacted.make({ token: "fixture-token" }),
        }),
      );
      yield* f.sql`update hosted_account_access set kind = 'shared', personal_user_id = null, audience = 'everyone' where account_id = ${ordinary.id}`;
      yield* f.request(f.owner, "appLink", params(f.app, "normalTokens", ordinary.id));
      const links = yield* f.request(f.spare, "appList", { app: f.app.id });
      const link = links.find((entry: any) => entry.account.id === ordinary.id);
      assert.equal(link.account.label, ordinary.label);
      assert.equal(link.account.description, ordinary.description);
      for (const user of [f.spare, f.owner]) {
        const read = yield* f.account(user, ordinary.id);
        assert.equal(read.account.label, ordinary.label);
        assert.equal(read.account.description, ordinary.description);
        const listed = yield* f.as(user, inventory(f.app.owner));
        const saved = listed.accounts.find((a: any) => a.id === ordinary.id);
        assert.equal(saved.label, ordinary.label);
        assert.equal(saved.description, ordinary.description);
        const directory = yield* f.as(
          user,
          resourceDirectory(user === f.owner ? "managed" : "available"),
        );
        const entry = directory.accounts.find((a: any) => a.account.id === ordinary.id);
        assert.equal(entry.account.label, ordinary.label);
        assert.equal(entry.account.description, ordinary.description);
      }
      const acquired = yield* f.connect(f.guest);
      yield* f.sql`update hosted_account_access set kind = 'shared', personal_user_id = null, audience = 'everyone' where account_id = ${acquired.id}`;
      assert.equal((yield* f.account(f.spare, acquired.id)).account.label, "Connected account");
      // A manager must see identity even without any health.apps through which to infer app edit access.
      yield* f.sql`delete from hosted_app_account_links where account = ${acquired.id}`;
      assert.equal(
        (yield* f.account(f.owner, acquired.id)).account.label,
        "upstream@example.invalid",
      );
      yield* f.as(
        f.guest,
        f.executor.accounts.update({
          owner: f.app.owner,
          account: acquired.id,
          label: "Team sandbox",
        }),
      );
      assert.equal((yield* f.account(f.spare, acquired.id)).account.label, "Team sandbox");
    }),
  );
});
