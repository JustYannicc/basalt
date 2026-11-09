import assert from "node:assert/strict";
import { test } from "node:test";
import { Crypto, Effect } from "effect";
import { providers } from "../../src/pool/provider-accounts/definitions.ts";
import { fixture } from "./provider-destinations-fixture.ts";
import { providerAccountContext, methods, sdk } from "./provider-destinations-modules.ts";

const native = { shape: "literal", native: true } as const;

test("installed generic apps supply every compatible family without a canonical package", async () => {
  await Effect.runPromise(
    fixture(
      ({ app, listed }) =>
        Effect.gen(function* () {
          for (let index = 0; index < listed.length; index++) {
            const candidate = listed[index]!;
            const slot = candidate.requirements.accounts.user;
            listed[index] = {
              ...candidate,
              copiedFrom: null,
              requirements: {
                accounts: slot === undefined ? {} : { personal: slot },
              },
            };
          }
          const context = yield* providerAccountContext(app, Object.keys(providers));
          for (const family of Object.keys(providers)) {
            const destination = context.destination(family);
            if (family === "iflow" || family === "qwen") {
              assert.deepEqual(destination, {
                kind: "unavailable",
                reason: "This provider app is not available in the catalog.",
              });
            } else {
              assert.deepEqual(
                destination,
                {
                  kind: "apps",
                  apps: [{ app: `app_${family}`, name: `app_${family}`, requirement: "personal" }],
                },
                family,
              );
            }
          }
        }),
      native,
    ),
  );
});

test("generic Jev and Cloudflare personal declarations retain the pool's exact provider identity", async () => {
  await Effect.runPromise(
    fixture(
      ({ app, listed }) =>
        Effect.gen(function* () {
          for (const family of ["jev", "cloudflare"]) {
            const slot = app.requirements.accounts[family]!;
            const { family: _family, ...definition } = slot.definition;
            const identified = yield* sdk.identifyProvider(definition, yield* Crypto.Crypto);
            assert.equal(identified.identity, slot.provider);
            const index = listed.findIndex((entry) => entry.id === `app_${family}`);
            listed[index] = {
              ...listed[index]!,
              copiedFrom: null,
              requirements: {
                accounts: {
                  personal: {
                    ...slot,
                    provider: identified.identity,
                    definition,
                    scope: "user",
                    capabilities: [],
                    contributed: false,
                  },
                },
              },
            };
          }
          const context = yield* providerAccountContext(app, ["jev", "cloudflare"]);
          for (const family of ["jev", "cloudflare"])
            assert.deepEqual(context.destination(family), {
              kind: "apps",
              apps: [{ app: `app_${family}`, name: `app_${family}`, requirement: "personal" }],
            });
        }),
      native,
    ),
  );
});

test("absent apps and incompatible installed identities keep the catalog destination", async () => {
  await Effect.runPromise(
    fixture(
      ({ app, listed }) =>
        Effect.gen(function* () {
          for (let index = 0; index < listed.length; index++)
            listed[index] = { ...listed[index]!, requirements: { accounts: {} } };
          const candidate = listed.find((entry) => entry.id === "app_jev")!;
          listed[listed.indexOf(candidate)] = {
            ...candidate,
            requirements: {
              accounts: {
                jev: {
                  ...app.requirements.accounts.jev!,
                  provider: sdk.ProviderId.make("prv_wrong"),
                },
              },
            },
          };
          const context = yield* providerAccountContext(app, ["jev", "cloudflare"]);
          for (const family of ["jev", "cloudflare"])
            assert.deepEqual(context.destination(family), {
              kind: "catalog",
              entry: `provider-${family}`,
            });
        }),
      native,
    ),
  );
});

test("destinations follow user, app and contributed account permissions", async () => {
  await Effect.runPromise(
    fixture(
      ({ app, listed }) =>
        Effect.gen(function* () {
          const context = yield* providerAccountContext(app, ["jev", "cloudflare"]);
          for (const family of ["jev", "cloudflare"]) {
            const destination = context.destination(family);
            assert.equal(destination.kind, "apps");
            if (destination.kind === "apps")
              assert.deepEqual(
                destination.apps.map((entry) => entry.requirement),
                ["contribution", "user"],
              );
          }
          const provider = listed.find((entry) => entry.id === "app_jev")!;
          const view = yield* methods.providerAccountMethodView(provider);
          for (const entry of view.connections.filter((entry) =>
            ["account", "contribution", "user"].includes(entry.requirement),
          ))
            assert.equal(entry.canConnect, entry.requirement !== "account");
        }),
      native,
    ),
  );
});

test("registered pools never become connection destinations, even with provider provenance", async () => {
  await Effect.runPromise(
    fixture(
      ({ app, listed, sql }) =>
        Effect.gen(function* () {
          const provider = listed.find((entry) => entry.id === "app_jev")!;
          yield* sql`update organization set metadata = jsonb_set(metadata::jsonb, '{basaltPools,second}', ${JSON.stringify({ app: provider.id })}::jsonb)::text`;
          const context = yield* providerAccountContext(app, ["jev"]);
          assert.deepEqual(context.destination("jev"), { kind: "catalog", entry: "provider-jev" });
        }),
      native,
    ),
  );
});

test("a destination needs an available method on both source and target requirements", async () => {
  await Effect.runPromise(
    fixture(
      ({ app, listed }) =>
        Effect.gen(function* () {
          const provider = listed.find((entry) => entry.id === "app_jev")!;
          listed[listed.indexOf(provider)] = {
            ...provider,
            requirements: {
              accounts: {
                jev: {
                  ...app.requirements.accounts.jev!,
                  capabilities: ["unavailable-capability"],
                },
              },
            },
          };
          let context = yield* providerAccountContext(app, ["jev"]);
          assert.deepEqual(context.destination("jev"), { kind: "catalog", entry: "provider-jev" });
          const target = {
            ...app,
            requirements: {
              accounts: {
                jev: {
                  ...app.requirements.accounts.jev!,
                  capabilities: ["unavailable-capability"],
                },
              },
            },
          };
          context = yield* providerAccountContext(target, ["jev"]);
          assert.deepEqual(context.destination("jev"), {
            kind: "unavailable",
            reason: "No connection method is available for this provider's required capabilities.",
          });
        }),
      native,
    ),
  );
});

test("hidden, inactive and authority-excluded apps stay out of destinations", async () => {
  await Effect.runPromise(
    fixture(
      ({ app, listed }) =>
        Effect.gen(function* () {
          listed.splice(
            listed.findIndex((entry) => entry.id === "app_jev"),
            1,
          );
          const inactive = listed.findIndex((entry) => entry.id === "app_inactive");
          listed[inactive] = {
            ...listed[inactive]!,
            requirements: {
              accounts: {
                personal: {
                  ...app.requirements.accounts.jev!,
                  scope: "user",
                  capabilities: [],
                },
              },
            },
          };
          const context = yield* providerAccountContext(app, ["jev", "gemini"]);
          assert.deepEqual(context.destination("jev"), { kind: "catalog", entry: "provider-jev" });
          assert.deepEqual(context.destination("gemini"), {
            kind: "catalog",
            entry: "provider-gemini",
          });
        }),
      { ...native, restricted: true },
    ),
  );
});
