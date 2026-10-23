import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeEuNamespaces } from "../../.upstream/apps/hosted/cloud/node_modules/alchemy/lib/Cloudflare/Workers/cloudflare_workers.js";

test("scopes all Basalt namespace bindings before native and Effect adapters use them", () => {
  const calls: string[] = [];
  const scoped = { getByName: (name: string) => `eu:${name}` };
  const namespace = {
    idFromName() {
      throw new Error("unscoped namespace used");
    },
    jurisdiction(value: string) {
      calls.push(value);
      return scoped;
    },
  };
  const env = { ALCHEMY_STACK_NAME: "basalt", ONE: namespace, TWO: namespace, TEXT: "value" };
  const result = scopeEuNamespaces(env);
  assert.equal(result.ONE, scoped);
  assert.equal(result.TWO, scoped);
  assert.equal(result.TEXT, "value");
  assert.equal(scoped.getByName("worker"), "eu:worker");
  assert.deepEqual(calls, ["eu", "eu"]);
  assert.equal(env.ONE, namespace);
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
  assert.throws(() => scopeEuNamespaces({ ...env, ALCHEMY_STACK_NAME: "basalt" }), /unsupported/);
});
