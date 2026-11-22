import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";
import {
  nativeControlPath,
  nativeControlPrefix,
  nativeModelHeader,
  nativeModelPrefix,
  nativeSessionHeader,
  nativeSessionPath,
} from "./native-contract.ts";
import { ControlFailure } from "./json.ts";
import { signEnvelope } from "./token.ts";

test("native tunnel leases bind the saved device and stop before failed revocation cleanup", async () => {
  const f = fixture();
  const grant = "native:tunnel-device";
  const control = async (action: string, values: Record<string, unknown> = {}) => {
    const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
      action,
      user: owner,
      grant,
      expiresAt: f.now() + 10_000,
      ...values,
    });
    return f.nativeControl(
      new Request("https://pool.example/native/v1/control", {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
    );
  };
  const response = await control("register", {
    intent: await f.intent(owner),
    name: "Tunnel device",
    tools: true,
    models: false,
  });
  assert.equal(response.status, 200);
  const { computer } = (await response.json()) as { computer: { id: string } };
  assert.equal(f.server.keys.length, 0, "A tools-only lease creates no model key");
  const session = async (changes: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
      action: "session",
      user: owner,
      grant,
      computer: computer.id,
      pool: pool.pool,
      expiresAt: f.now() + 10_000,
      ...changes,
    });
    return f.nativeSession(
      new Request(`https://pool.example${nativeSessionPath}`, {
        headers: { upgrade: "websocket", [nativeSessionHeader]: envelope },
        ...(signal ? { signal } : {}),
      }),
    );
  };
  f.restart();
  const lease = await session();
  assert.equal(lease.signal.aborted, false);
  for (const changes of [
    { user: member },
    { grant: "native:another" },
    { computer: "foreign" },
    { pool: "foreign" },
    { action: "check" },
    { expiresAt: f.now() - 1 },
  ])
    await assert.rejects(session(changes));
  const abort = new AbortController();
  const disconnected = await session({}, abort.signal);
  abort.abort();
  assert.equal(disconnected.signal.aborted, true);
  disconnected.release();
  let closed = false;
  lease.onClose(() => {
    closed = true;
  });
  f.server.revokeFailure = true;
  await control("revoke", { computer: computer.id, pool: pool.pool });
  assert.equal(lease.signal.aborted, true);
  assert.equal(closed, true);
  f.restart();
  await assert.rejects(session());
});

/** A device approved for models and tools while the pool container was stopped. */
async function approvedWhileStopped(grant: string) {
  const f = fixture();
  const intent = await f.intent(owner);
  f.server.stopped = true;
  const signed = (prefix: string, values: Record<string, unknown>) =>
    signEnvelope(signingKey, prefix, {
      user: owner,
      grant,
      expiresAt: f.now() + 10_000,
      ...values,
    });
  const control = async (values: Record<string, unknown>) =>
    f.nativeControl(
      new Request(`https://pool.example${nativeControlPath}`, {
        method: "POST",
        body: JSON.stringify({ envelope: await signed(nativeControlPrefix, values) }),
      }),
    );
  const response = await control({
    action: "register",
    intent,
    name: "Approved while stopped",
    tools: true,
    models: true,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const { computer } = (await response.json()) as { computer: { id: string } };
  const identity = { computer: computer.id, pool: pool.pool };
  return {
    f,
    check: () => control({ action: "check", ...identity }),
    session: async () =>
      f.nativeSession(
        new Request(`https://pool.example${nativeSessionPath}`, {
          headers: {
            upgrade: "websocket",
            [nativeSessionHeader]: await signed(nativeControlPrefix, {
              action: "session",
              ...identity,
            }),
          },
        }),
      ),
    model: async () =>
      f.nativeModel(
        new Request("https://pool.example/v1/responses", {
          method: "POST",
          headers: {
            [nativeModelHeader]: await signed(nativeModelPrefix, {
              ...identity,
              method: "POST",
              path: "/v1/responses",
            }),
          },
          body: JSON.stringify({ model: "pending-model" }),
        }),
      ),
  };
}
const modelsUnavailable = (error: unknown) =>
  error instanceof ControlFailure &&
  error.status === 503 &&
  error.retryAfterSeconds !== undefined &&
  /Models are unavailable right now/.test(error.message);

test("before its model key exists a device keeps its tools and its models answer unavailable", async () => {
  const device = await approvedWhileStopped("native:pending-models");
  assert.equal((await device.check()).status, 200);
  const lease = await device.session();
  assert.equal(lease.signal.aborted, false);
  lease.release();
  await assert.rejects(device.model(), modelsUnavailable);
  assert.equal(device.f.server.keys.length, 0);
});

test("once the container answers, the device's models work without a new approval", async () => {
  const device = await approvedWhileStopped("native:returning-models");
  await assert.rejects(device.model(), modelsUnavailable);
  device.f.server.stopped = false;
  const lease = await device.model();
  const key = String(device.f.server.keys[0]?.api_key);
  assert.equal(lease.request.headers.get("authorization"), `Bearer ${key}`);
  lease.release();
  device.f.restart();
  const next = await device.model();
  assert.equal(next.request.headers.get("authorization"), `Bearer ${key}`);
  next.release();
  assert.equal(device.f.server.keys.length, 1);
});
