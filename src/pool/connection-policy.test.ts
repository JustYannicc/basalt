import assert from "node:assert/strict";
import { test } from "node:test";
import { attributionStorageKey } from "./attribution.ts";
import { signEnvelope } from "./token.ts";
import { fixture, error, provider, signingKey } from "./test/control.ts";

async function retainedSignIn(f: Awaited<ReturnType<typeof fixture>>, completed = false) {
  const session = {
    pool: "pool-a",
    provider,
    state: "synthetic-retired-state",
    flow: "device",
    expiresAt: new Date(f.deps.now().getTime() + 20 * 60_000).toISOString(),
  };
  f.storage.values.set(attributionStorageKey, {
    version: 2,
    assigned: [],
    locks: {
      [provider]: {
        pool: session.pool,
        state: session.state,
        snapshot: ["retained-credential"],
        flow: session.flow,
        expires: f.deps.now().getTime() + 16 * 60_000,
        lastPoll: f.deps.now().getTime(),
        checkAt: f.deps.now().getTime(),
      },
    },
    sessions: {
      [session.state]: {
        session,
        accountId: "fake-owner",
        pendingIds: ["new-unlinked-credential"],
      },
    },
  });
  f.home.sessions.set(session.state, {
    provider,
    status: completed ? "ok" : "wait",
    auth_ids: completed ? ["new-unlinked-credential"] : [],
  });
  f.home.addGroup("pool-a", 1, ["retained-credential"]);
  f.home.addFile("retained-credential");
  f.home.addFile("new-unlinked-credential");
  return signEnvelope(signingKey, "sbs1", session);
}

for (const [path, method] of [
  ["/sign-ins", "POST"],
  ["/login-files", "POST"],
  ["/sign-ins/callback", "POST"],
  ["/sign-ins/status?session=stale", "GET"],
]) {
  test(`old deployed pool acquisition ${method} ${path} refuses before any state or provider work`, async () => {
    const f = await fixture();
    await retainedSignIn(f, true);
    const before = structuredClone([...f.storage.values]);
    const response = await f.call(path!, {
      method,
      ...(method === "POST" ? { raw: "invalid JSON" } : {}),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "ProviderAppConnectionRequired",
      app: "pool-a",
      requirement: "subscriptions",
      message:
        "Connect this account on its provider app, then select the saved account in this pool.",
      destination: {
        kind: "unavailable",
        reason: "Open the provider app from the dashboard to connect an account.",
      },
    });
    assert.equal(f.storage.gets, 0);
    assert.equal(f.storage.puts, 0);
    assert.deepEqual([...f.storage.values], before);
    assert.equal(f.home.calls.length, 0);
    await error(await f.call(path!, { method, owner: false }), "not_owner", 403);
    await error(await f.call(path!, { method, token: "invalid" }), "unauthorized", 401);
    assert.equal(f.home.calls.length, 0);
  });
}

for (const completed of [false, true]) {
  test(`old sign-in cancellation never finalizes a credential, completed=${completed}`, async () => {
    const f = await fixture();
    const session = await retainedSignIn(f, completed);
    const response = await f.call(`/sign-ins?session=${encodeURIComponent(session)}`, {
      method: "DELETE",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.json(), null);
    assert.deepEqual(
      f.home.members.map((member) => member.auth_id),
      ["retained-credential"],
    );
    assert.deepEqual([...f.home.files.keys()], ["retained-credential", "new-unlinked-credential"]);
    assert.equal(
      f.home.calls.some((call) => call.path.includes("/oauth/status")),
      false,
    );
    assert.equal(
      f.home.calls.some((call) => call.method === "POST" || call.method === "PATCH"),
      false,
    );
  });

  test(`eviction and an alarm never assign an old sign-in result, completed=${completed}`, async () => {
    const f = await fixture();
    await retainedSignIn(f, completed);
    f.restart();
    await f.expire();
    f.restart();
    await f.expire();
    assert.deepEqual(
      f.home.members.map((member) => member.auth_id),
      ["retained-credential"],
    );
    assert.equal(f.home.files.has("retained-credential"), true);
    assert.equal(f.home.files.has("new-unlinked-credential"), true);
    assert.equal(
      f.home.calls.some((call) => call.path.includes("/oauth/status")),
      false,
    );
    assert.equal(
      f.home.calls.some((call) => call.method === "POST" || call.method === "PATCH"),
      false,
    );
  });
}

test("a failed old-session cleanup stays retryable without acquiring or altering retained membership", async () => {
  const f = await fixture();
  await retainedSignIn(f, true);
  f.home.override = (path) =>
    path.includes("/oauth/session") ? Response.json({}, { status: 503 }) : undefined;
  await f.expire();
  assert.deepEqual(
    f.home.members.map((member) => member.auth_id),
    ["retained-credential"],
  );
  f.home.override = undefined;
  f.restart();
  f.advance(30_000);
  await f.expire();
  assert.deepEqual(
    f.home.members.map((member) => member.auth_id),
    ["retained-credential"],
  );
  assert.equal(
    f.home.calls.some((call) => call.path.includes("/oauth/status")),
    false,
  );
});
