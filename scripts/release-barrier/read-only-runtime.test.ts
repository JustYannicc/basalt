import assert from "node:assert/strict";
import { test } from "node:test";
import { requiredSecrets } from "../environment.ts";
import {
  assertReadOnlyPlanContext,
  readOnlyFetch,
  readOnlyPlanEnvironment,
  readOnlySecretNames,
} from "./read-only-runtime.ts";
import { BarrierRefusal } from "./manifest.ts";
import { readOnlyFailure } from "./read-only-failure.ts";
import { ReadOnlyStateStoreVersionMismatch } from "alchemy/State/ReadOnlyHttpStateStore";
import { StateStoreError } from "alchemy/State/State";

const candidate = "a".repeat(40);
const trusted = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REPOSITORY: "JustYannicc/basalt",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: candidate,
};

test("the preflight entry accepts only exact main and batch push candidates in the repository", () => {
  for (const ref of ["refs/heads/main", "refs/heads/batch/b29"])
    assert.doesNotThrow(() =>
      assertReadOnlyPlanContext({ ...trusted, GITHUB_REF: ref }, candidate),
    );
  for (const changes of [
    { GITHUB_ACTIONS: "false" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REPOSITORY: "fork/basalt" },
    { GITHUB_REF: "refs/pull/12/merge" },
    { GITHUB_REF: "refs/heads/untrusted" },
    { GITHUB_SHA: "b".repeat(40) },
  ])
    assert.throws(
      () => assertReadOnlyPlanContext({ ...trusted, ...changes }, candidate),
      /untrusted-context/,
    );
});

test("provider credentials come only from explicit preflight aliases and never fall back to deployment tokens", () => {
  const source: NodeJS.ProcessEnv = {
    ...Object.fromEntries(requiredSecrets.map((name) => [name, `fixture-${name}`])),
    ...Object.fromEntries(readOnlySecretNames.map((name) => [name, `fixture-${name}`])),
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_DEPLOYMENT_KEY: "cd".repeat(32),
  };
  const env = readOnlyPlanEnvironment(source);
  assert.equal(env.CI, "true");
  assert.equal(env.ALCHEMY_STAGE, "production");
  assert.equal(env.CLOUDFLARE_API_TOKEN, source.BASALT_PREFLIGHT_CLOUDFLARE_API_TOKEN);
  assert.equal(env.PLANETSCALE_API_TOKEN_ID, source.BASALT_PREFLIGHT_PLANETSCALE_API_TOKEN_ID);
  assert.equal(env.PLANETSCALE_API_TOKEN, source.BASALT_PREFLIGHT_PLANETSCALE_API_TOKEN);
  for (const key of readOnlySecretNames)
    assert.throws(() => readOnlyPlanEnvironment({ ...source, [key]: "" }), new RegExp(key));
});

test("the provider transport refuses writes and foreign destinations before fetch and disables redirects on reads", async () => {
  const calls: Array<{ method: string; redirect: RequestRedirect | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ method: new Request(input, init).method, redirect: init?.redirect });
    return Response.json({ result: [] });
  };
  const read = readOnlyFetch("https://state.example.test", fetcher);
  for (const origin of [
    "https://state.example.test",
    "https://api.cloudflare.com",
    "https://api.planetscale.com",
  ])
    assert.equal((await read(`${origin}/read`)).status, 200);
  assert.deepEqual(
    calls,
    Array.from({ length: 3 }, () => ({ method: "GET", redirect: "error" })),
  );
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
    await assert.rejects(
      read("https://api.cloudflare.com/private", { method }),
      (error: unknown) => {
        assert.ok(error instanceof BarrierRefusal);
        assert.deepEqual(error.delta?.changed, [{ path: "method", old: "GET", new: method }]);
        return true;
      },
    );
  await assert.rejects(
    read("https://private.example.test/secret?credential=private"),
    /read-only-network-origin/,
  );
  assert.equal(calls.length, 3);
});

test("state and wrapped transport failures retain bounded refusal details", async () => {
  const version = readOnlyFailure(new ReadOnlyStateStoreVersionMismatch(8, 7), []);
  assert.ok(version instanceof BarrierRefusal);
  assert.deepEqual(version.delta?.changed, [{ path: "version", old: 7, new: 8 }]);
  const access = readOnlyFailure(
    new StateStoreError({ message: "private", http: { status: 401 } }),
    [],
  );
  assert.ok(access instanceof BarrierRefusal);
  assert.deepEqual(access.delta?.changed, [{ path: "http.status", old: 200, new: 401 }]);
  const refused: BarrierRefusal[] = [];
  const read = readOnlyFetch(
    "https://state.example.test",
    () => assert.fail("Transport must not execute"),
    (error) => refused.push(error),
  );
  await assert.rejects(read("https://api.cloudflare.com/private", { method: "POST" }));
  await assert.rejects(read("https://private.example.test/private"));
  const wrapped = readOnlyFailure(new Error("private SDK cause"), refused);
  assert.ok(wrapped instanceof BarrierRefusal);
  assert.equal(wrapped.refusals?.length, 2);
  assert.ok(!JSON.stringify(wrapped).includes("private.example.test"));
  assert.ok(!JSON.stringify(wrapped).includes("private SDK cause"));
});
