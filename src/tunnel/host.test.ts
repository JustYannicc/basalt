import assert from "node:assert/strict";
import { test } from "node:test";
import { tunnelProtocol } from "../../clients/contracts/tunnel.ts";
import { handleTunnel } from "./host.ts";
import type { TunnelEnvironment } from "./access.ts";

const tunnelUrl = "https://app.example.test/native/v1/tunnel";

// The access lookup answers 401, so a request that reaches it has passed the handshake checks.
async function handshake(origin?: string | string[], protocol = tunnelProtocol) {
  let accessReads = 0;
  const env: TunnelEnvironment = {
    TOOLS_SERVICE: {
      fetch: async () => {
        accessReads++;
        return new Response(null, { status: 401 });
      },
    },
    POOL_SERVICE: { fetch: async () => new Response(null, { status: 500 }) },
    POOL_APP_SIGNING_KEY: "0".repeat(64),
  };
  const headers = new Headers({
    upgrade: "websocket",
    "sec-websocket-protocol": protocol,
    authorization: "Bearer synthetic-native-token",
  });
  for (const value of origin === undefined ? [] : [origin].flat()) headers.append("origin", value);
  const response = await handleTunnel(new Request(tunnelUrl, { headers }), env);
  return { status: response.status, accessReads };
}

test("a native client without an Origin reaches bearer access", async () => {
  assert.deepEqual(await handshake(), { status: 401, accessReads: 1 });
});

test("v2 uses the same bearer admission and unsupported protocols refuse before admission", async () => {
  assert.deepEqual(await handshake(undefined, "basalt.tunnel.v2"), { status: 401, accessReads: 1 });
  for (const protocol of ["basalt.tunnel.v3", "basalt.tunnel.v2, basalt.tunnel.v1"])
    assert.deepEqual(await handshake(undefined, protocol), { status: 400, accessReads: 0 });
});

test("a React Native client sending this server's own Origin reaches bearer access", async () => {
  assert.deepEqual(await handshake("https://app.example.test"), { status: 401, accessReads: 1 });
});

test("any other Origin is refused before access is read", async () => {
  for (const origin of [
    "https://attacker.example",
    "null",
    "http://app.example.test",
    "https://app.example.test:8443",
    "https://sub.app.example.test",
    "https://app.example.test.attacker.example",
    "https://app.example.test/",
    "https://app.example.test:443",
    "",
    ["https://app.example.test", "https://attacker.example"],
  ])
    assert.deepEqual(
      await handshake(origin),
      { status: 400, accessReads: 0 },
      `Origin ${JSON.stringify(origin)}`,
    );
});

test("timing distinguishes a held access check from a held lease", async (context) => {
  const events: { stage: string }[] = [];
  context.mock.method(console, "info", (line: string) => {
    if (line.startsWith("NATIVE_TUNNEL_TIMING ")) events.push(JSON.parse(line.slice(21)));
  });
  const access = Promise.withResolvers<Response>();
  const lease = Promise.withResolvers<Response>();
  const enteredLease = Promise.withResolvers<void>();
  const pending = handleTunnel(
    new Request(tunnelUrl, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": tunnelProtocol,
        authorization: "Bearer synthetic-native-token",
      },
    }),
    {
      POOL_APP_SIGNING_KEY: "0".repeat(64),
      TOOLS_SERVICE: { fetch: () => access.promise },
      POOL_SERVICE: {
        fetch: () => {
          enteredLease.resolve();
          return lease.promise;
        },
      },
    },
  );
  try {
    assert.deepEqual(
      events.map((event) => event.stage),
      ["start"],
    );
    access.resolve(
      Response.json({
        id: "native:test",
        userId: "test",
        clientId: "test",
        expiresAt: Date.now() + 60_000,
        policy: { kind: "native", computer: "test", pool: "test", models: true },
      }),
    );
    await enteredLease.promise;
    assert.deepEqual(
      events.map((event) => event.stage),
      ["start", "access"],
    );
    lease.reject(new Error("synthetic lease failure"));
    assert.equal((await pending).status, 503);
    assert.deepEqual(
      events.map((event) => event.stage),
      ["start", "access", "failed"],
    );
  } finally {
    access.resolve(new Response(null, { status: 401 }));
    lease.resolve(new Response(null, { status: 503 }));
    await pending;
  }
});
