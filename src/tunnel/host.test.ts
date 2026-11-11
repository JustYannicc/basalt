import assert from "node:assert/strict";
import { test } from "node:test";
import { tunnelProtocol } from "../../clients/contracts/tunnel.ts";
import { handleTunnel } from "./host.ts";
import type { TunnelEnvironment } from "./access.ts";

const tunnelUrl = "https://app.example.test/native/v1/tunnel";

// The access lookup answers 401, so a request that reaches it has passed the handshake checks.
async function handshake(origin?: string) {
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
    "sec-websocket-protocol": tunnelProtocol,
    authorization: "Bearer synthetic-native-token",
  });
  if (origin !== undefined) headers.set("origin", origin);
  const response = await handleTunnel(new Request(tunnelUrl, { headers }), env);
  return { status: response.status, accessReads };
}

test("a native client without an Origin reaches bearer access", async () => {
  assert.deepEqual(await handshake(), { status: 401, accessReads: 1 });
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
    "",
  ])
    assert.deepEqual(
      await handshake(origin),
      { status: 400, accessReads: 0 },
      `Origin ${JSON.stringify(origin)}`,
    );
});
