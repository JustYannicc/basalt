import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { decodeTunnelFrame, tunnelLimits } from "../../clients/contracts/tunnel.ts";
import { nativeModelHeader, nativeModelPrefix } from "../pool/native-contract.ts";
import { openEnvelope } from "../pool/token.ts";
import { tunnelAccess, type TunnelEnvironment } from "./access.ts";
import type { TunnelSocket } from "./platform.ts";
import { serveTunnel } from "./session.ts";

class Peer extends EventTarget implements TunnelSocket {
  binaryType: BinaryType = "arraybuffer";
  sent: string[] = [];
  accept() {}
  send(data: Parameters<WebSocket["send"]>[0]) {
    this.sent.push(String(data));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  frame(value: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ v: 1, ...value }) }));
  }
}

const signingKey = "ab".repeat(32);
/** The stated bound: a reused bearer check answers operations opened this soon after it. */
const bound = 3_000;
const now = 1_800_000_000_000;
const grant = (bearer: string) => ({
  id: `native:${bearer}`,
  userId: `person-${bearer}`,
  clientId: "synthetic-client",
  expiresAt: now + 3_600_000,
  policy: { kind: "native", computer: `computer-${bearer}`, pool: "synthetic-pool", models: true },
});

/** A session opened the way the router opens one: the bearer check, then operations over it. */
async function tunnel(context: TestContext, bearer: string, answers: Response[] = []) {
  const checks: string[] = [];
  const assertions: Record<string, unknown>[] = [];
  const env: TunnelEnvironment = {
    POOL_APP_SIGNING_KEY: signingKey,
    TOOLS_SERVICE: {
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, "/api/auth/native/access");
        checks.push(request.headers.get("authorization")!);
        return answers.shift() ?? Response.json(grant(bearer));
      },
    },
    POOL_SERVICE: {
      fetch: async (request) => {
        const assertion = request.headers.get(nativeModelHeader);
        assert.ok(assertion);
        assertions.push(
          (await openEnvelope(signingKey, nativeModelPrefix, assertion)) as Record<string, unknown>,
        );
        return new Response(new TextEncoder().encode('{"data":[]}'));
      },
    },
  };
  const upgrade = new Request("https://router.example/native/v1/tunnel", {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const access = await tunnelAccess(upgrade, env);
  assert.ok(!(access instanceof Response));
  const socket = new Peer();
  const lease = new Peer();
  const work: Promise<unknown>[] = [];
  serveTunnel(socket, lease, upgrade, env, access, (pending) => work.push(pending));
  context.after(() => lease.close());
  let id = 0;
  return {
    checks,
    assertions,
    /** One model request over this session; resolves with its response status. */
    request: async () => {
      const operation = ++id;
      socket.frame({
        type: "open",
        id: operation,
        operation: { service: "models", method: "GET", path: "/v1/models", transport: "http" },
        headers: {},
      });
      const running = work.at(-1);
      socket.frame({ type: "credit", id: operation, bytes: tunnelLimits.windowBytes });
      await running;
      const response = socket.sent
        .map((frame) => decodeTunnelFrame(frame, "server"))
        .find((frame) => frame.type === "response" && frame.id === operation);
      assert.ok(response?.type === "response");
      return response.status;
    },
  };
}

test("a tunneled model request checks its bearer once", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const session = await tunnel(context, "device-a");
  assert.equal(await session.request(), 200);
  assert.deepEqual(session.checks, ["Bearer device-a"], "the session's check answers its request");
  assert.deepEqual(
    session.assertions.map((value) => ({
      user: value.user,
      grant: value.grant,
      computer: value.computer,
    })),
    [{ user: "person-device-a", grant: "native:device-a", computer: "computer-device-a" }],
  );
});

test("an operation after the bound checks again and honours the answer", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const session = await tunnel(context, "device-a", [
    Response.json(grant("device-a")),
    new Response(null, { status: 401 }),
  ]);
  assert.equal(await session.request(), 200);
  context.mock.timers.tick(bound - 1);
  assert.equal(await session.request(), 200, "within the bound the session's check still holds");
  assert.equal(session.checks.length, 1);
  context.mock.timers.tick(1);
  assert.equal(await session.request(), 401, "a revocation is observed once the bound passes");
  assert.equal(session.checks.length, 2);
  assert.equal(session.assertions.length, 2, "the refused request never reaches the pool");
});

test("each session's operations carry only that session's check", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const first = await tunnel(context, "device-a");
  const second = await tunnel(context, "device-b");
  assert.equal(await second.request(), 200);
  assert.equal(await first.request(), 200);
  assert.deepEqual(first.checks, ["Bearer device-a"]);
  assert.deepEqual(second.checks, ["Bearer device-b"]);
  assert.deepEqual(
    [...first.assertions, ...second.assertions].map((value) => ({
      user: value.user,
      grant: value.grant,
    })),
    [
      { user: "person-device-a", grant: "native:device-a" },
      { user: "person-device-b", grant: "native:device-b" },
    ],
  );
});
