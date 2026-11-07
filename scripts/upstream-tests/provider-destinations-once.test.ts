import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect } from "effect";
import { providers as poolProviders } from "../../src/pool/provider-accounts/definitions.ts";
import { fixture } from "./provider-destinations-fixture.ts";
import {
  destinations,
  methods,
  resources,
  providerAccountContext,
} from "./provider-destinations-modules.ts";
import { oldDestination, oldMethods } from "./provider-destinations-oracle.ts";

for (const shape of ["mixed", "literal"] as const) {
  for (const manage of [true, false]) {
    for (const restricted of [false, true]) {
      test(`${shape} 15-requirement pool methods are byte-identical (manage=${manage}, restricted=${restricted})`, async () => {
        await Effect.runPromise(
          fixture(
            ({ app }) =>
              Effect.gen(function* () {
                assert.equal(Object.keys(app.requirements.accounts).length, 15);
                if (shape === "literal") {
                  const { pool, ...families } = app.requirements.accounts;
                  assert.deepEqual(Object.keys(families), Object.keys(poolProviders));
                  const token = pool?.definition.auth.token;
                  assert.ok(token?.type === "secrets");
                  assert.equal(token.provisioned, true);
                  assert.equal(pool?.cardinality, "one");
                  assert.equal(pool?.contributed, false);
                  assert.ok(
                    Object.values(families).every(
                      (slot) =>
                        slot.scope === "app" && slot.cardinality === "many" && slot.contributed,
                    ),
                  );
                }
                const before = yield* oldMethods(app);
                const after = yield* methods.providerAccountMethodView(app);
                assert.deepEqual(after, before);
                assert.equal(JSON.stringify(after), JSON.stringify(before));
                assert.ok(after.unavailable.length > 0);
                assert.ok(after.connections.every((entry) => !entry.canConnect));
                if (!manage) {
                  assert.deepEqual(
                    after.connections.find((entry) => entry.requirement === "openai")?.destination,
                    {
                      kind: "unavailable",
                      reason: "Account management access is required.",
                    },
                  );
                }
                const chosen = JSON.stringify(after.connections);
                assert.equal(chosen.includes("app_hidden_anthropic"), false);
                assert.equal(chosen.includes("app_inactive"), false);
                if (restricted) assert.equal(chosen.includes('"app_gemini"'), false);
                if (manage) {
                  assert.deepEqual(
                    after.connections.find((entry) => entry.requirement === "anthropic")
                      ?.destination,
                    {
                      kind: "apps",
                      apps: [
                        {
                          app: "app_anthropic",
                          name: "app_anthropic",
                          requirement: "contribution",
                        },
                      ],
                    },
                  );
                }
              }),
            { manage, restricted, shape },
          ),
        );
      });
    }
  }
}

for (const shape of ["mixed", "literal"] as const) {
  test(`${shape} organization-wide destination reads happen once per methods call`, async () => {
    await Effect.runPromise(
      fixture(
        ({ app, reads, reset }) =>
          Effect.gen(function* () {
            yield* methods.providerAccountMethodView(app);
            assert.deepEqual(
              {
                apps: reads.apps,
                catalog: reads.catalog,
                installs: reads.installs,
                accesses: reads.accesses,
              },
              { apps: 1, catalog: 1, installs: 1, accesses: 1 },
            );
            assert.equal(reads.pool, 1);
            assert.equal(reads.checked, 1);
            reset();
            yield* methods.providerAccountMethodView(app);
            assert.equal(reads.apps, 1, "the next call reads fresh state");
            assert.equal(reads.installs, 1);
          }),
        { shape },
      ),
    );
  });
}

test("non-managers never read the provider app inventory or installs", async () => {
  await Effect.runPromise(
    fixture(
      ({ app, reads }) =>
        Effect.gen(function* () {
          yield* methods.providerAccountMethodView(app);
          assert.equal(reads.apps, 0);
          assert.equal(reads.installs, 0);
          assert.equal(reads.accesses, 0);
        }),
      { manage: false },
    ),
  );
});

for (const state of ["empty", "failed", "absent"] as const) {
  test(`catalog refusal and reason ordering stay identical (${state})`, async () => {
    await Effect.runPromise(
      fixture(
        ({ app, setCatalog, reads, reset }) =>
          Effect.gen(function* () {
            if (state !== "absent") setCatalog(state);
            const before = yield* oldMethods(app);
            reset();
            const after = yield* methods.providerAccountMethodView(app);
            assert.equal(JSON.stringify(after), JSON.stringify(before));
            assert.equal(reads.apps, 0);
            assert.equal(reads.installs, 0);
          }),
        { manage: false, catalog: state !== "absent" },
      ),
    );
  });
}

test("requirements without registered families skip organization-wide reads", async () => {
  await Effect.runPromise(
    fixture(({ app, reads }) =>
      Effect.gen(function* () {
        const accounts = app.requirements.accounts;
        const retained = {
          ...app,
          requirements: {
            accounts: {
              subscriptions: accounts.subscriptions!,
              automatic: accounts.automatic!,
              unknown: accounts.unknown!,
            },
          },
        };
        assert.deepEqual(
          yield* methods.providerAccountMethodView(retained),
          yield* oldMethods(retained),
        );
        assert.deepEqual(
          {
            apps: reads.apps,
            catalog: reads.catalog,
            installs: reads.installs,
            accesses: reads.accesses,
          },
          { apps: 0, catalog: 0, installs: 0, accesses: 0 },
        );
      }),
    ),
  );
});

for (const manage of [true, false]) {
  test(`provider-app classification and imports are byte-identical (manage=${manage})`, async () => {
    await Effect.runPromise(
      fixture(
        ({ app, reads, reset }) =>
          Effect.gen(function* () {
            const before = yield* oldMethods(app);
            reset();
            const after = yield* methods.providerAccountMethodView(app);
            assert.equal(JSON.stringify(after), JSON.stringify(before));
            assert.deepEqual(after.providerApp, {
              family: "openai",
              requirements: ["primary", "legacy"],
            });
            assert.deepEqual(after.connections[0]?.importMethods, manage ? ["codex"] : []);
            assert.equal(reads.catalog, 1);
            assert.equal(reads.installs, 1);
          }),
        { pool: false, manage },
      ),
    );
  });
}

test("standalone destination rechecks use the same rule and fresh reads", async () => {
  await Effect.runPromise(
    fixture(({ app, reads, reset, setCatalog }) =>
      Effect.gen(function* () {
        for (const requirement of [...Object.keys(app.requirements.accounts), "missing"]) {
          assert.deepEqual(
            yield* destinations.providerAccountDestination(app, requirement),
            yield* oldDestination(app, requirement),
          );
        }
        reset();
        const first = yield* destinations.providerAccountDestination(app, "openai");
        assert.equal(first.kind, "apps");
        setCatalog("empty");
        const second = yield* destinations.providerAccountDestination(app, "openai");
        assert.deepEqual(second, {
          kind: "unavailable",
          reason: "This provider app is not available in the catalog.",
        });
        assert.equal(reads.catalog, 2);
      }),
    ),
  );
});

test("app read access remains mandatory", async () => {
  await Effect.runPromise(
    fixture(({ app, sql, reads }) =>
      Effect.gen(function* () {
        yield* sql`delete from hosted_app_access where id = ${app.id}`;
        const result = yield* Effect.result(methods.providerAccountMethodView(app));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure._tag, "OrganizationForbidden");
        assert.equal(reads.apps, 0);
        assert.equal(reads.installs, 0);
      }),
    ),
  );
});

test("checked access for another app never replaces the target's check", async () => {
  await Effect.runPromise(
    fixture(({ app, listed, reads }) =>
      Effect.gen(function* () {
        const checked = yield* resources.requireCurrentAppAccess(listed[0]!.id, "read");
        yield* methods.providerAccountMethodView(app, checked);
        assert.equal(reads.checked, 2);
      }),
    ),
  );
});

test("a route's already-checked access can be reused", async () => {
  await Effect.runPromise(
    fixture(({ app, reads }) =>
      Effect.gen(function* () {
        const checked = yield* resources.requireCurrentAppAccess(app.id, "read");
        yield* methods.providerAccountMethodView(app, checked);
        assert.equal(reads.checked, 1);
      }),
    ),
  );
});

test("unprepared requirements are defects even when classification resolved them", async () => {
  await Effect.runPromise(
    fixture(({ app }) =>
      Effect.gen(function* () {
        const context = yield* providerAccountContext(app, ["openai"], { classify: true });
        assert.equal(context.destination("openai").kind, "apps");
        for (const requirement of ["anthropic", "missing"]) {
          const result = yield* Effect.exit(Effect.sync(() => context.destination(requirement)));
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.ok(Cause.hasDies(result.cause));
            assert.equal(Cause.hasFails(result.cause), false);
          }
        }
      }),
    ),
  );
});
