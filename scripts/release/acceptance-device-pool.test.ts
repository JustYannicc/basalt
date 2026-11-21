import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeControlPath, nativeControlPrefix, nativeModelHeader } from "../../src/pool/native-contract.ts";
import { fixture, owner, pool, previousKey, signingKey } from "../../src/pool/test/computers.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { acceptanceAssertionTtlMs, acceptanceCredential } from "./acceptance-device.ts";

/**
 * The pool's own check of what the release sends: the real `NativeComputers.model` behind the
 * controller, with an in-memory registry and directory. Only Home's HTTP API is a stand-in.
 */
async function registered(models = true) {
  const f = fixture();
  const grant = `native:release-acceptance-${models ? "models" : "tools"}`;
  const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
    action: "register",
    user: owner,
    grant,
    name: "Release acceptance",
    models,
    tools: !models,
    intent: await f.intent(owner),
    expiresAt: f.now() + 10_000,
  });
  const response = await f.nativeControl(
    new Request(`https://pool.example${nativeControlPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
  );
  assert.equal(response.status, 200, await response.clone().text());
  const { computer } = (await response.json()) as { computer: { id: string } };
  return { f, device: { computer: computer.id, grant, user: owner, pool: pool.pool } };
}

type Registered = Awaited<ReturnType<typeof registered>>;
/** Signs as the release does, then sends what `sent` names (by default what was signed). */
async function call(
  { f, device }: Registered,
  options: {
    device?: object;
    key?: string;
    previous?: string;
    clock?: () => number;
    signed?: readonly [string, string];
    sent?: readonly [string, string];
  } = {},
) {
  const credential = acceptanceCredential(
    {
      POOL_ACCEPTANCE_DEVICE: JSON.stringify(options.device ?? device),
      POOL_APP_SIGNING_KEY: options.key ?? signingKey,
      ...(options.previous ? { POOL_APP_SIGNING_KEY_PREVIOUS: options.previous } : {}),
    },
    options.clock ?? f.now,
  );
  const [method, path] = options.signed ?? ["GET", "/v1/models"];
  const [sentMethod, sentPath] = options.sent ?? [method, path];
  const headers = await credential(method, path);
  return f.nativeModel(
    new Request(`https://pool.example${sentPath}`, {
      method: sentMethod,
      headers,
      ...(sentMethod === "POST" ? { body: "{}" } : {}),
    }),
  );
}
const refused = (work: Promise<unknown>, status: number) =>
  assert.rejects(work, (error: unknown) => {
    assert.equal((error as { status?: unknown }).status, status, String(error));
    return true;
  });

test("the pool accepts the release's assertion and forwards with the device's own Home key", async () => {
  const live = await registered();
  for (const [method, path] of [
    ["GET", "/v1/models"],
    ["POST", "/v1/chat/completions"],
  ] as const) {
    const admitted = await call(live, { signed: [method, path] });
    admitted.release();
    assert.equal(admitted.pool, pool.pool);
    assert.equal(admitted.person, owner);
    assert.equal(admitted.request.headers.has(nativeModelHeader), false);
    assert.equal(
      admitted.request.headers.get("authorization"),
      `Bearer ${live.f.server.keys[0]!.api_key}`,
    );
  }
});

test("the pool refuses an expired assertion, and one that outlives its 30 s bound", async () => {
  const live = await registered();
  const now = live.f.now;
  // A runner clock behind the pool's by the whole lifetime: expired on arrival.
  await refused(call(live, { clock: () => now() - acceptanceAssertionTtlMs }), 401);
  (await call(live, { clock: () => now() - acceptanceAssertionTtlMs + 1 })).release();
  // Ahead by more than 30 s minus the lifetime: past the pool's bound.
  await refused(call(live, { clock: () => now() + 30_000 - acceptanceAssertionTtlMs + 1 }), 401);
  (await call(live, { clock: () => now() + 30_000 - acceptanceAssertionTtlMs })).release();
  // An assertion that expired in flight.
  const credential = acceptanceCredential(
    { POOL_ACCEPTANCE_DEVICE: JSON.stringify(live.device), POOL_APP_SIGNING_KEY: signingKey },
    now,
  );
  const headers = await credential("GET", "/v1/models");
  live.f.advance(acceptanceAssertionTtlMs);
  await refused(live.f.nativeModel(new Request("https://pool.example/v1/models", { headers })), 401);
});

test("the pool refuses an assertion sent with another method, path or query", async () => {
  const live = await registered();
  await refused(call(live, { signed: ["GET", "/v1/models"], sent: ["POST", "/v1/models"] }), 401);
  await refused(
    call(live, {
      signed: ["POST", "/v1/chat/completions"],
      sent: ["POST", "/v1/responses"],
    }),
    401,
  );
  await refused(
    call(live, { signed: ["GET", "/v1/models"], sent: ["GET", "/v1/models?limit=1"] }),
    401,
  );
  await refused(
    call(live, { signed: ["GET", "/v1/models?limit=1"], sent: ["GET", "/v1/models"] }),
    401,
  );
});

test("the pool refuses another key, an unknown or mismatched device, and a tools-only one", async () => {
  const live = await registered();
  await refused(call(live, { key: "ef".repeat(32) }), 401);
  await refused(call(live, { device: { ...live.device, computer: "computer-unknown" } }), 401);
  await refused(call(live, { device: { ...live.device, grant: "native:another-grant" } }), 401);
  await refused(call(live, { device: { ...live.device, user: "user-member" } }), 401);
  await refused(call(await registered(false)), 403);
});

test("mid-rotation the release signs with the previous key, which both Workers accept", async () => {
  const live = await registered();
  // Before the apply: the serving Worker's current key is the release's previous one; the
  // release's new current key is unknown to it.
  (await call(live, { key: "ef".repeat(32), previous: signingKey })).release();
  // After the apply: the new Worker keeps the old key as its previous.
  (await call(live, { key: signingKey, previous: previousKey })).release();
});
