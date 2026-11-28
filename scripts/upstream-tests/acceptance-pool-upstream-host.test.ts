import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, ConfigProvider, Effect, Exit } from "effect";
import {
  acceptanceUpstreamBinding,
  upstreamOrigin,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/guard.ts";

const name = "BASALT_ACCEPTANCE_UPSTREAM_HOST";
/** The tools Worker's settings the deploy binds for the acceptance pool, from the deploy's env. */
const deployed = (env: Record<string, string>) =>
  Effect.runSyncExit(
    acceptanceUpstreamBinding.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  );
const bound = (env: Record<string, string>) => {
  const exit = deployed(env);
  assert.ok(Exit.isSuccess(exit), JSON.stringify(env));
  return exit.value;
};

test("an unset or blank deploy input binds no setting on the tools Worker", () => {
  // An unset Actions secret or variable still reaches the deploy, as an empty string.
  const envs: Array<Record<string, string>> = [
    {},
    { [name]: "" },
    { [name]: "   " },
    { [name]: "\n" },
  ];
  for (const env of envs) assert.deepEqual(bound(env), {}, JSON.stringify(env));
});

test("a host binds as the bare host name it was given", () => {
  assert.deepEqual(bound({ [name]: "upstream.example.test" }), { [name]: "upstream.example.test" });
  assert.deepEqual(bound({ [name]: "  gateway.account-1.workers.dev\n" }), {
    [name]: "gateway.account-1.workers.dev",
  });
});

test("a host the route would refuse stops the deploy by the setting's name, never its value", () => {
  for (const host of [
    "https://upstream.example.test",
    "upstream.example.test:443",
    "upstream.example.test/path",
    "Upstream.Example.Test",
    "upstream",
    "user@upstream.example.test",
    "upstream..example.test",
  ]) {
    const exit = deployed({ [name]: host });
    assert.ok(Exit.isFailure(exit), host);
    // The deploy stops on a config error, as for any other setting it cannot use.
    const error = Cause.squash(exit.cause) as { _tag?: unknown; message?: unknown };
    assert.equal(error._tag, "ConfigError", host);
    assert.ok(String(error.message).includes(name), host);
    assert.ok(!String(error.message).includes(host), host);
  }
});

test("the deploy binds exactly the hosts the route builds an origin from", () => {
  for (const host of [
    "upstream.example.test",
    "gateway.account-1.workers.dev",
    "a.b",
    "-bad.example.test",
    "bad-.example.test",
    "upstream",
    "UPPER.example.test",
    "upstream.example.test.",
    `${"a".repeat(64)}.example.test`,
    `${"a".repeat(63)}.example.test`,
    "under_score.example.test",
  ]) {
    const exit = deployed({ [name]: host });
    const binds = Exit.isSuccess(exit) && exit.value[name as keyof typeof exit.value] === host;
    assert.equal(binds, upstreamOrigin(host) !== undefined, host);
  }
});
