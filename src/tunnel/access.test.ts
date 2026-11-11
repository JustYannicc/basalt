import assert from "node:assert/strict";
import { test } from "node:test";
import { tunnelLease } from "./access.ts";
import { nativeModelRequest } from "../native-model.ts";
import { fixture, owner, pool, signingKey } from "../pool/test/computers.ts";
import { signEnvelope } from "../pool/token.ts";
import { nativeControlPrefix } from "../pool/native-contract.ts";

async function device() {
  const f = fixture();
  const id = "native:clock-fixture";
  const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
    action: "register",
    user: owner,
    grant: id,
    expiresAt: f.now() + 10_000,
    intent: await f.intent(owner),
    name: "Clock fixture",
    models: true,
    tools: true,
  });
  const response = await f.nativeControl(
    new Request("https://pool.example/native/v1/control", {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
  );
  assert.equal(response.status, 200);
  const { computer } = (await response.json()) as { computer: { id: string } };
  return {
    f,
    access: {
      id,
      userId: owner,
      clientId: "synthetic-client",
      expiresAt: f.now() + 3_600_000,
      policy: {
        kind: "native" as const,
        computer: computer.id,
        pool: pool.pool,
        models: true,
        toolsOrganization: pool.organization,
      },
    },
  };
}

for (const skew of [0, 1, 50, 5_000]) {
  test(`tunnel and native model assertions survive a signer clock ${skew}ms ahead`, async (t) => {
    const { f, access } = await device();
    t.mock.method(Date, "now", () => f.now() + skew);
    const socket = {
      accept() {},
      send() {},
      close() {},
      binaryType: "arraybuffer" as const,
      addEventListener() {},
    };
    let sessions = 0,
      models = 0;
    const env = {
      POOL_APP_SIGNING_KEY: signingKey,
      TOOLS_SERVICE: { fetch: async () => Response.json(access) },
      POOL_SERVICE: {
        fetch: async (request: Request) => {
          if (new URL(request.url).pathname === "/native/v1/session") {
            const lease = await f.nativeSession(request);
            sessions++;
            lease.release();
            const response = new Response(null);
            Object.defineProperties(response, {
              status: { value: 101 },
              webSocket: { value: socket },
            });
            return response;
          }
          const admitted = await f.nativeModel(request);
          models++;
          admitted.release();
          return Response.json({ data: [{ id: "synthetic-model" }] });
        },
      },
    };
    assert.equal(
      await tunnelLease(new Request("https://router.example/native/v1/tunnel"), env, access),
      socket,
    );
    const response = await nativeModelRequest(
      new Request("https://router.example/v1/models", {
        headers: { authorization: "Bearer synthetic-native-token" },
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: "synthetic-model" }] });
    assert.equal(sessions, 1);
    assert.equal(models, 1);
  });
}

test("closing one native tunnel lease leaves overlapping and subsequent leases usable", async () => {
  const { f, access } = await device();
  const acquire = async () => {
    const envelope = await signEnvelope(signingKey, nativeControlPrefix, {
      action: "session",
      user: owner,
      grant: access.id,
      computer: access.policy.computer,
      pool: pool.pool,
      expiresAt: f.now() + 10_000,
    });
    return f.nativeSession(
      new Request("https://pool.example/native/v1/session", {
        headers: { upgrade: "websocket", "x-basalt-native-session": envelope },
      }),
    );
  };
  const first = await acquire();
  const second = await acquire();
  let secondClosed = false;
  second.onClose(() => {
    secondClosed = true;
  });
  first.release();
  const third = await acquire();
  assert.equal(second.signal.aborted, false);
  assert.equal(secondClosed, false);
  assert.equal(third.signal.aborted, false);
  second.release();
  third.release();
});

for (const operation of ["tunnel", "model"] as const)
  test(`internal ${operation} authorization honors 429 before dispatching once`, async () => {
    const { access } = await device();
    access.expiresAt = Date.now() + 3_600_000;
    let checks = 0,
      forwarded = 0;
    const times: number[] = [];
    const env = {
      POOL_APP_SIGNING_KEY: signingKey,
      TOOLS_SERVICE: {
        fetch: async () => {
          checks++;
          times.push(Date.now());
          return checks === 1
            ? new Response(null, { status: 429, headers: { "retry-after": "1" } })
            : Response.json(access);
        },
      },
      POOL_SERVICE: {
        fetch: async () => {
          forwarded++;
          return Response.json({ data: [] });
        },
      },
    };
    const request = new Request(
      `https://router.example/${operation === "model" ? "v1/models" : "native/v1/tunnel"}`,
      { headers: { authorization: "Bearer synthetic-native" } },
    );
    if (operation === "tunnel") {
      const { tunnelAccess } = await import("./access.ts");
      assert.deepEqual(await tunnelAccess(request, env), access);
      assert.equal(forwarded, 0);
    } else {
      const response = await nativeModelRequest(request, env);
      assert.equal(response.status, 200);
      assert.equal(forwarded, 1);
    }
    assert.equal(checks, 2);
    assert.ok(times[1]! - times[0]! >= 950, "Internal authorization must wait for Retry-After.");
  });
