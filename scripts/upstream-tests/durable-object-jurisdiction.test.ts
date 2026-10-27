import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeEuNamespaces } from "../../.upstream/apps/hosted/cloud/node_modules/alchemy/lib/Cloudflare/Workers/cloudflare_workers.js";

function namespace(calls: string[], scoped: object) {
  return {
    idFromName() {
      throw new Error("unscoped namespace used");
    },
    jurisdiction(value: string) {
      calls.push(value);
      return scoped;
    },
  };
}

test("scopes all Basalt namespace bindings before native and Effect adapters use them", () => {
  const calls: string[] = [];
  const scoped = { getByName: (name: string) => `eu:${name}` };
  const shared = namespace(calls, scoped);
  const env = { ALCHEMY_STACK_NAME: "basalt", ONE: shared, TWO: shared, TEXT: "value" };
  const result = scopeEuNamespaces(env);
  assert.equal(result.ONE, scoped);
  assert.equal(result.ONE, scoped);
  assert.equal(result.TWO, scoped);
  assert.equal(result.TEXT, "value");
  assert.equal(scoped.getByName("worker"), "eu:worker");
  assert.deepEqual(calls, ["eu", "eu"]);
  assert.equal(env.ONE, shared);
});

test("reads bindings from an env that resolves them on access and exposes no own keys", () => {
  // The importable env from cloudflare:workers resolves bindings on access; copying its keys loses them.
  const calls: string[] = [];
  const scoped = { getByName: () => "stub" };
  const bindings: Record<string, unknown> = {
    ALCHEMY_STACK_NAME: "basalt",
    ScheduleCoordinator: namespace(calls, scoped),
    SECRET: "value",
  };
  const env = new Proxy({}, { get: (_target, name) => bindings[String(name)] });
  assert.deepEqual(Object.keys(env), []);
  const result = scopeEuNamespaces(env);
  assert.equal(result.ScheduleCoordinator, scoped);
  assert.equal(result.SECRET, "value");
  assert.deepEqual(calls, ["eu"]);
});

test("leaves service binding stubs alone and wraps an env only once", () => {
  // A JS RPC stub answers every property with a callable, including jurisdiction and idFromName.
  const stub = new Proxy(() => {}, { get: () => () => { throw new Error("RPC call made"); } });
  const calls: string[] = [];
  const scoped = { getByName: () => "stub" };
  const env = { ALCHEMY_STACK_NAME: "basalt", Service: stub, Coordinator: namespace(calls, scoped) };
  const once = scopeEuNamespaces(env);
  assert.equal(once.Service, stub);
  assert.equal(scopeEuNamespaces(once), once);
  assert.equal(once.Coordinator, scoped);
  assert.deepEqual(calls, ["eu"]);
});

test("leaves another stack's bindings intact and fails when EU scoping fails", () => {
  const env = {
    ALCHEMY_STACK_NAME: "other",
    VALUE: {
      idFromName() {},
      jurisdiction() {
        throw new Error("unsupported");
      },
    },
  };
  assert.equal(scopeEuNamespaces(env), env);
  const basalt = scopeEuNamespaces({ ...env, ALCHEMY_STACK_NAME: "basalt" });
  assert.throws(() => basalt.VALUE, /unsupported/);
});
