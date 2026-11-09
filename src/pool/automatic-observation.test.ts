import assert from "node:assert/strict";
import { test } from "node:test";
import { observeAutomaticPool } from "./automatic-observation.ts";
import { BackendFailure, HomeTransportFailure } from "./json.ts";
import type { ProbeDependencies } from "./availability.ts";

function fixture() {
  const policy = {
    pool: "synthetic-pool",
    organization: "synthetic-org",
    revision: 1,
    dirty: false,
    native: true,
    accounts: [],
    expiresAt: 1_000,
    installedRevision: 1,
    installedUntil: 1_000,
  };
  const deps: ProbeDependencies = {
    runtime: async () => {},
    view: async () => {
      throw new HomeTransportFailure("transport");
    },
    membership: async () => ({ policy }),
    native: async () => {},
    now: () => 0,
  };
  return { deps, policy };
}

test("only a failed view transport with readable health and exact installed policy is automatic", async () => {
  const f = fixture();
  assert.equal(await observeAutomaticPool("synthetic-pool", f.deps), "view-transport");
  f.deps.view = async () => {};
  assert.equal(await observeAutomaticPool("synthetic-pool", f.deps), "healthy");
});

test("policy400, a dirty or expired revision and native guard loss never authorize a restart", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.policy.dirty = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.policy.installedRevision = 0;
    },
    (f: ReturnType<typeof fixture>) => {
      f.policy.installedUntil = 0;
    },
    (f: ReturnType<typeof fixture>) => {
      f.deps.native = async () => {
        throw new BackendFailure(400);
      };
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal(await observeAutomaticPool("synthetic-pool", f.deps), "policy-invalid");
  }
  const f = fixture();
  assert.equal(
    await observeAutomaticPool("synthetic-pool", {
      ...f.deps,
      membership: async () => ({
        policy: f.policy,
        failure: { guard: "native_policy_install", failure: "response_status", backendStatus: 400 },
      }),
    }),
    "policy-invalid",
  );
});

test("stopped, unready, signature/data failures and unknown failures require human authority", async () => {
  const f = fixture();
  f.deps.runtime = async () => {
    throw new Error("unready");
  };
  assert.equal(await observeAutomaticPool("synthetic-pool", f.deps), "unready");
  f.deps.runtime = async () => {};
  for (const error of [
    new BackendFailure(400),
    new BackendFailure(401),
    new Error("invalid-data"),
  ]) {
    f.deps.view = async () => {
      throw error;
    };
    assert.equal(await observeAutomaticPool("synthetic-pool", f.deps), "unknown");
  }
});

test("a pending view cannot consume the native guard's observation deadline", async () => {
  const f = fixture();
  const controller = new AbortController();
  const checked = Promise.withResolvers<void>();
  f.deps.view = (_pool, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  f.deps.native = async () => {
    checked.resolve();
  };
  const pending = observeAutomaticPool("synthetic-pool", f.deps, controller.signal);
  await checked.promise;
  controller.abort(new DOMException("synthetic view deadline", "TimeoutError"));
  assert.equal(await pending, "view-transport");
});
