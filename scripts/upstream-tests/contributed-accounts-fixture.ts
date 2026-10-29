import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, Layer, Option, Redacted, Schema, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { personalOrgFixture } from "./pool-personal-org-fixture.ts";
import { load, implementation, contracts } from "./pool-access-fixture.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { layer: cryptoLayer } = await import(require.resolve("@effect/platform-node/NodeCrypto"));
const sdk = await load("packages/sdk/src/core.ts");
const { memoryRepositories } = await load("packages/sdk/src/testing.ts");
const { filesystemBlobStore } = await load("packages/sdk/src/node.ts");
const { createAppHandler, hostContext } = await load("packages/apps/src/host.ts");
const { fullAuthority } = await load("packages/authorization/src/index.ts");
const { CurrentAuthorization } = await load(`${contracts}authorization.ts`);
const { GroupDatabase } = await load(`${contracts}groups.ts`);
const { CurrentOrganization, organizationOwner, RequireOrganization } = await load(
  `${contracts}organization.ts`,
);
const { CurrentUserId, Authentication, ApiAuthentication } = await load(`${contracts}auth.ts`);
const { HostedExecutor } = await load(`${contracts}executor.ts`);
const { ScheduleWakeup } = await load(`${contracts}schedules.ts`);
const { HostedAppRuntime } = await load(`${contracts}app-ui.ts`);
const { hostedResourceLifecycle, sharedAppCreation } = await load(
  `${implementation}resource-lifecycle.ts`,
);
const { migrateGroups } = await load(`${implementation}group-schema.ts`);
const { migrateResourceAccess } = await load(`${implementation}resource-schema.ts`);
const { migrateAppAccountLinks } = await load(`${implementation}app-account-schema.ts`);
const { migrateContributedDepartures } = await load(
  `${implementation}contributed-departure-schema.ts`,
);
const { migrateAccountIdentityIndex } = await load(`${implementation}account-identity-schema.ts`);
const { hostedAppAccountHandlers } = await load(`${implementation}app-account-links.ts`);
const { hostedGroupHandlers } = await load(`${implementation}groups.ts`);
const { shareApp } = await load(`${implementation}resource-access.ts`);
const { HostedApi } = await load(`${contracts}api.ts`);
const { connectAccount, submitConnection, disconnectAccount, getAccount, checkAccount } =
  await load(`${implementation}accounts.ts`);
const { startInteractive, interactiveStatus } = await load(
  `${implementation}interactive-accounts.ts`,
);
const { AccountTargets } = await load(`${contracts}account-grants.ts`);

export const authorUrl = new URL("../../.upstream/packages/apps/src/index.ts", import.meta.url)
  .href;
const hookKey = Symbol.for("basalt/contributed-fixture/remove");
export const appSource = `
import { defineApp, defineProvider, interactive, secrets, object, string } from ${JSON.stringify(authorUrl)};
const subscription = defineProvider({ name: "Contributed fixture", auth: { device: interactive({ label: "Sign in" }) } });
const handlers = {
  start: async () => ({ session: "fixture-session", url: "https://example.invalid/authorize", code: "FIXTURE" }),
  status: async () => ({ state: "connected", ref: "opaque-fixture-reference", accountInfo: { email: "upstream@example.invalid" } }),
  submit: async () => ({ state: "connected", ref: "opaque-fixture-reference", accountInfo: { email: "upstream@example.invalid" } }),
  remove: async (ctx, input) => globalThis[Symbol.for("basalt/contributed-fixture/remove")](ctx, input.ref),
  check: async () => ({
    accountInfo: { displayName: "Upstream person", email: "upstream@example.invalid", username: "upstream-user", avatarUrl: "https://example.invalid/avatar.png", profileUrl: "https://example.invalid/profile" },
    status: { badges: [{ label: "Pro plan", tone: "neutral" }, { label: "Available", tone: "good", identity: false }],
      meters: [{ label: "5 hours", remaining: 0.75 }], stats: [
        { label: "Note", value: "Sign in again as alice@example.invalid" },
        { label: "Plan", value: "Personal plan", identity: true },
        { label: "Requests", value: "42", identity: false },
      ] },
  }),
};
const regular = defineProvider({ name: "Secret fixture", health: handlers.check, auth: { token: secrets({ label: "Token", fields: object({ token: string() }) }) } });
export default defineApp({ app: { accounts: {
  shared: subscription.many().contributed(), ordinary: subscription.many(),
  tokens: regular.many().contributed(), normalTokens: regular.many(),
} } }, { connect: { shared: handlers, ordinary: handlers } });
`;

/** Real framework dispatch, SDK storage/retirement, hosted handlers and native Better Auth share Postgres.
 * The fixture runs authored JS in this process, avoiding a second deployment or a workerd install.
 */
export const contributedFixture = async (
  run: (f: any) => Effect.Effect<unknown, unknown, any>,
  options: { plainContribution?: boolean } = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), "basalt-contributed-"));
  const handlers = new Map<string, any>();
  let removals = 0;
  const removeContexts: any[] = [];
  let failRemove = false;
  let afterRemove = async () => {};
  Reflect.set(globalThis, hookKey, async (ctx: any, ref: string) => {
    assert.ok(ctx.app.accounts, "remove gets the real app account context");
    assert.equal(ref, "opaque-fixture-reference");
    removeContexts.push(ctx);
    if (failRemove) throw new Error("Fixture remove unavailable");
    removals++;
    await afterRemove();
  });
  const invoke = (input: any, command: any) =>
    Effect.gen(function* () {
      const handler = handlers.get(input.build);
      assert.ok(handler, `unknown fixture build ${input.build}`);
      const accounts =
        input.accounts === undefined ? { app: {}, user: {} } : Redacted.value(input.accounts);
      const response: any = yield* Effect.promise(() =>
        handler(
          new Request("https://app.invalid", { method: "POST", body: JSON.stringify(command) }),
          hostContext(accounts, undefined, input.caller),
        ),
      );
      const body: any = yield* Effect.promise(() => response.json());
      if (!body.ok) return yield* Effect.fail(body.error);
      return body.value;
    });
  const runtime = sdk.runtimeAdapter({
    build: ({ files }: any) =>
      Effect.gen(function* () {
        const source = files.find((f: any) => f.path === "index.ts").content;
        const hash = createHash("sha256").update(source).digest("hex");
        const path = join(directory, `${hash}.mjs`);
        yield* Effect.promise(() => writeFile(path, source));
        const module = yield* Effect.promise(() => import(pathToFileURL(path).href));
        const build = sdk.BuildId.make(`bld_${hash}`);
        handlers.set(build, createAppHandler(module.default));
        const requirements = yield* invoke({ build }, { operation: "requirements" });
        if (options.plainContribution) requirements.accounts.app.shared.cardinality = "one";
        return { build, requirements };
      }),
    inspect: (input: any) => invoke(input, { operation: "inspect" }),
    index: (input: any) => invoke(input, { operation: "index" }),
    skills: (input: any) => invoke(input, { operation: "skills" }),
    connect: (input: any) => invoke(input, input.command),
    checkAccount: (input: any) =>
      invoke(input, { operation: "account-check", requirement: input.requirement }),
    query: (input: any) =>
      invoke(input, { operation: "query", name: input.name, input: input.input }),
    mutate: (input: any) =>
      invoke(input, { operation: "mutate", name: input.name, input: input.input }),
    call: (input: any) =>
      invoke(input, { operation: "call", tool: input.tool, input: input.input }),
    changes: () => Stream.empty,
  });
  try {
    await personalOrgFixture(
      (base: any) =>
        Effect.gen(function* () {
          const { sql, org, owner, guest, auth } = base;
          const storage = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
          yield* storage.migrate;
          yield* migrateGroups;
          yield* migrateResourceAccess;
          yield* migrateAppAccountLinks;
          yield* migrateContributedDepartures;
          yield* migrateAccountIdentityIndex;
          const lifecycle = yield* hostedResourceLifecycle.pipe(
            Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          );
          const executor = yield* sdk
            .createExecutor({
              database: storage,
              secret: Redacted.make("ab".repeat(32)),
              origin: "http://localhost:3000",
              git: memoryRepositories(),
              blobs: filesystemBlobStore({ directory: join(directory, "blobs") }),
              runtime,
              hooks: lifecycle.hooks,
            })
            .pipe(Effect.provide(cryptoLayer));
          yield* lifecycle.attach(executor);
          const as = (user: any, effect: any) =>
            effect.pipe(
              Effect.provideService(CurrentUserId, user.id),
              Effect.provideService(CurrentAuthorization, fullAuthority),
              Effect.provideService(sdk.CurrentActor, user.id),
              Effect.provideService(CurrentOrganization, {
                organization: org.id,
                owner: organizationOwner(org.id),
                role: user.id === owner.id ? "owner" : "member",
              }),
              Effect.provideService(GroupDatabase, Effect.succeed(sql)),
              Effect.provideService(HostedExecutor, Effect.succeed(executor)),
              Effect.provideService(ScheduleWakeup, Effect.void),
              // App payloads read whether a build has a screen; without `screen` it stays unknown.
              Effect.provideService(HostedAppRuntime, { asset: () => Effect.die("no assets") }),
            );
          const context = yield* Layer.build(
            Layer.mergeAll(hostedAppAccountHandlers, hostedGroupHandlers).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(RequireOrganization, (effect: any) => effect),
                  Layer.succeed(Authentication, { origin: "http://localhost:3000" }),
                  Layer.succeed(ApiAuthentication, {}),
                ),
              ),
            ),
          );
          const registered = context.mapUnsafe.get(HostedApi.groups.appAccounts.key).handlers;
          const request = (user: any, name: string, params: any) =>
            as(user, registered.get(name).handler({ params }));
          const { app } = yield* as(
            owner,
            executor.apps
              .deploy({
                owner: organizationOwner(org.id),
                name: "Contributed fixture",
                files: [{ path: "index.ts", content: appSource }],
              })
              .pipe(sharedAppCreation),
          );
          yield* Effect.promise(() =>
            auth.api.addMember({
              body: { organizationId: org.id, userId: guest.id, role: "member" },
            }),
          );
          const spare = yield* base.signup("Other member", "other@example.invalid");
          yield* Effect.promise(() =>
            auth.api.addMember({
              body: { organizationId: org.id, userId: spare.id, role: "member" },
            }),
          );
          const connect = (user: any, requirement = "shared", destination?: any) =>
            as(
              user,
              Effect.gen(function* () {
                const pending = yield* connectAccount(organizationOwner(org.id), {
                  app: app.id,
                  requirement,
                  scope: "app",
                  ...(destination === undefined ? {} : { destination }),
                });
                yield* startInteractive(pending.id, "device");
                const connected = yield* interactiveStatus(pending.id);
                assert.equal(connected.state, "connected", JSON.stringify(connected));
                return connected.account;
              }),
            );
          const token = (user: any, requirement = "tokens") =>
            as(
              user,
              Effect.gen(function* () {
                const pending = yield* connectAccount(organizationOwner(org.id), {
                  app: app.id,
                  requirement,
                  scope: "app",
                });
                return yield* submitConnection(organizationOwner(org.id), {
                  connection: pending.id,
                  method: "token",
                  fields: Redacted.make({ token: "fixture-token" }),
                });
              }),
            );
          const target = (effect: any, action: string, account: string) =>
            effect.pipe(Effect.provideService(AccountTargets[action], { account }));
          const background = (effect: any) =>
            effect.pipe(
              Effect.provideService(GroupDatabase, Effect.succeed(sql)),
              Effect.provideService(HostedExecutor, Effect.succeed(executor)),
              Effect.provideService(ScheduleWakeup, Effect.void),
              Effect.provideService(CurrentUserId, undefined),
              Effect.provideService(sdk.CurrentActor, undefined),
            );
          yield* run({
            ...base,
            share: (audience: any) =>
              as(
                owner,
                Effect.gen(function* () {
                  const [policy] =
                    yield* sql`select revision from hosted_app_access where id = ${app.id}`;
                  return yield* shareApp(app.id, audience, policy.revision);
                }),
              ),
            group: (name: string, payload: any, group?: string) =>
              as(
                owner,
                context.mapUnsafe
                  .get(HostedApi.groups.groups.key)
                  .handlers.get(name)
                  .handler({ params: { organization: org.id, group }, payload }),
              ),
            executor,
            app,
            spare,
            as,
            background,
            request,
            connect,
            token,
            pending: (user: any, requirement: string) =>
              as(user, connectAccount(app.owner, { app: app.id, requirement, scope: "app" })),
            start: (user: any, connection: string) =>
              as(user, startInteractive(connection, "device")),
            afterRemove: (callback: () => Promise<void>) => {
              afterRemove = callback;
            },
            removeAccount: (user: any, account: string) =>
              as(user, target(disconnectAccount, "delete", account)),
            account: (user: any, account: string) =>
              as(user, target(getAccount, "inspect", account)),
            check: (user: any, account: string) => as(user, target(checkAccount, "use", account)),
            removals: () => removals,
            removeContexts: () => removeContexts,
            failRemove: () => {
              failRemove = true;
            },
            recoverRemove: () => {
              failRemove = false;
            },
          });
        }),
      { userDeletion: true },
    );
  } finally {
    Reflect.deleteProperty(globalThis, hookKey);
    await rm(directory, { recursive: true, force: true });
  }
};
