import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, ConfigProvider, Effect, Schema } from "effect";
import { fixture, load, implementation, contracts, secret } from "./pool-access-fixture.ts";
import { verifyPoolToken } from "../../src/pool/token.ts";
const { AppId } = await load("packages/sdk/src/core.ts");
const { OrganizationForbidden } = await load(`${contracts}organization.ts`);
const { CurrentUserId } = await load(`${contracts}auth.ts`);
const { mintPoolManagerToken } = await load(`${implementation}pool-manager-tokens.ts`);
const { MintPoolManagerToken } = await load(`${contracts}pool-manager-tokens.ts`);
const pool = Schema.decodeUnknownSync(AppId)("app_pool-fixture");
const configured = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ env: { POOL_APP_SIGNING_KEY: secret } }),
    ),
  );

test("a pool manager mints for themselves at the fifteen-minute cap", async () => {
  await fixture(() =>
    configured(
      Effect.gen(function* () {
        const before = Math.floor(Date.now() / 1000);
        const result = yield* mintPoolManagerToken(pool, { user: "owner", lifetimeSeconds: 900 });
        const verified = yield* Effect.promise(() => verifyPoolToken(secret, result.token));
        assert.equal(verified?.owner, "owner");
        assert.equal(verified?.pool, pool);
        assert.ok(
          verified?.exp !== undefined &&
            verified.exp >= before + 900 &&
            verified.exp <= Math.floor(Date.now() / 1000) + 900,
        );
        assert.equal(Date.parse(result.expiresAt), verified.exp * 1000);
      }),
    ),
  );
});

test("non-managers and requests for another person are refused", async () => {
  await fixture(() =>
    configured(
      Effect.gen(function* () {
        for (const [caller, requested] of [
          ["guest", "guest"],
          ["owner", "guest"],
          ["guest", "owner"],
        ]) {
          const result = yield* Effect.exit(
            mintPoolManagerToken(pool, { user: requested, lifetimeSeconds: 900 }).pipe(
              Effect.provideService(CurrentUserId, caller),
            ),
          );
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure")
            assert.ok(Schema.is(OrganizationForbidden)(Cause.squash(result.cause)));
        }
      }),
    ),
  );
});

test("native managers are resolved from current app policy; retained pools keep their recorded owner", async () => {
  await fixture(({ sql }) =>
    configured(
      Effect.gen(function* () {
        const mint = mintPoolManagerToken(pool, { user: "other", lifetimeSeconds: 60 }).pipe(
          Effect.provideService(CurrentUserId, "other"),
        );
        assert.equal((yield* Effect.exit(mint))._tag, "Failure");
        yield* sql`update organization set metadata = jsonb_set(metadata::jsonb, '{basaltPools,owner,authorization}', '"executor-app-v1"'::jsonb)::text`;
        assert.equal((yield* Effect.exit(mint))._tag, "Success");
        yield* sql`update member set role = 'member' where "userId" = 'other'`;
        assert.equal((yield* Effect.exit(mint))._tag, "Failure");
      }),
    ),
  );
});

test("mint lifetime accepts the cap and refuses larger or invalid requests", () => {
  assert.equal(Schema.is(MintPoolManagerToken)({ user: "owner", lifetimeSeconds: 900 }), true);
  for (const lifetimeSeconds of [901, 0, -1, 1.5, Infinity])
    assert.equal(Schema.is(MintPoolManagerToken)({ user: "owner", lifetimeSeconds }), false);
});
