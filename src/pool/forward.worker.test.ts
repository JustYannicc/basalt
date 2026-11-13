import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolLifecycle } from "./lifecycle.ts";
import { NativeMemberships } from "./membership.ts";
import { modelDrainProtocol } from "./model-drain-contract.ts";
import {
  nativeControlPath,
  nativeControlPrefix,
  nativeModelHeader,
  nativeModelPrefix,
} from "./native-contract.ts";
import { NativeStreams } from "./native-streams.ts";
import { RuntimeProtection } from "./runtime-protection.ts";
import { fixture, owner, pool, signingKey } from "./test/computers.ts";
import { signEnvelope } from "./token.ts";

test("forwarding reserves the private drain protocol for verified native assertions", async () => {
  const f = fixture();
  const streams = new NativeStreams();
  const never = async (): Promise<never> => {
    throw new Error("Unexpected control operation");
  };
  const memberships = new NativeMemberships({
    storage: f.storage,
    signingKey,
    read: never,
    actual: never,
    reconcile: never,
    install: never,
    abort: () => assert.fail("Unexpected abort"),
    schedule: never,
  });
  const lifecycle = new PoolLifecycle(
    { running: () => true, start: never, stop: never, keepAlive: never, status: never },
    {
      ...f.storage,
      get: (key) => f.storage.get(key),
      put: (key, value) => f.storage.put(key, value),
      getAlarm: never,
      setAlarm: never,
    },
    "fixture",
  );
  const forwarded: Request[] = [];
  const deps = {
    env: { POOL_APP_SIGNING_KEY: signingKey },
    computers: { nativeModel: f.nativeModel, observeUsage: async () => {} },
    memberships,
    streams,
    lifecycle: Promise.resolve(lifecycle),
    protection: new RuntimeProtection(streams, {
      check: never,
      defer: () => {},
      unavailable: () => {},
    }),
    route: async (request: Request) => {
      forwarded.push(request);
      return new Response(null, { status: 204 });
    },
    fetch: never,
    defer: () => {},
  };
  const module = "./forward.worker.ts";
  const {
    forwardPoolRequest,
  }: {
    forwardPoolRequest(request: Request, port: 8317, dependencies: typeof deps): Promise<Response>;
  } = await import(module);
  for (const [offered, expected] of [
    [modelDrainProtocol, null],
    [`other, ${modelDrainProtocol}`, "other"],
    [` ${modelDrainProtocol} , other , ${modelDrainProtocol}`, "other"],
    ["other", "other"],
  ]) {
    const response = await forwardPoolRequest(
      new Request("https://pool.example/v1/responses", {
        headers: { upgrade: "websocket", "sec-websocket-protocol": offered! },
      }),
      8317,
      deps,
    );
    assert.equal(response.status, 204);
    assert.equal(forwarded.at(-1)?.headers.get("sec-websocket-protocol"), expected);
  }
  const grant = "native:forward-fixture";
  const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
    action: "register",
    user: owner,
    grant,
    models: true,
    tools: true,
    expiresAt: f.now() + 10_000,
    intent: await f.intent(owner),
    name: "Native fixture",
  });
  const registration = await f.nativeControl(
    new Request(`https://pool.example${nativeControlPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
  );
  assert.equal(registration.status, 200);
  const { computer } = (await registration.json()) as { computer: { id: string } };
  const assertion = await signEnvelope(signingKey, nativeModelPrefix, {
    user: owner,
    grant,
    computer: computer.id,
    pool: pool.pool,
    expiresAt: f.now() + 10_000,
    method: "GET",
    path: "/v1/responses",
    modelDrain: modelDrainProtocol,
  });
  const response = await forwardPoolRequest(
    new Request("https://pool.example/v1/responses", {
      headers: {
        upgrade: "websocket",
        [nativeModelHeader]: assertion,
        "sec-websocket-protocol": "other",
      },
    }),
    8317,
    deps,
  );
  assert.equal(response.status, 204);
  assert.equal(forwarded.at(-1)?.headers.get("sec-websocket-protocol"), modelDrainProtocol);
  assert.equal(forwarded.at(-1)?.headers.has(nativeModelHeader), false);
  assert.equal(
    forwarded.at(-1)?.headers.get("authorization"),
    `Bearer ${f.server.keys[0]!.api_key}`,
  );
});
