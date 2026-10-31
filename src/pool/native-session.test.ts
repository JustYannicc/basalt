import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";
import { nativeControlPrefix, nativeSessionHeader, nativeSessionPath } from "./native-contract.ts";
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
