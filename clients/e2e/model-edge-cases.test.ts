import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { request } from "node:http";
import type { Duplex } from "node:stream";
import { fixtureHome, independentAgent } from "./support.ts";
import { remoteFixture } from "./remote-fixture.ts";

let remote: Awaited<ReturnType<typeof remoteFixture>>;
let profile: Awaited<ReturnType<typeof fixtureHome>>;
let runtime: Awaited<ReturnType<Awaited<ReturnType<typeof fixtureHome>>["start"]>>;
let token: string;
before(async () => {
  remote = await remoteFixture();
  profile = await fixtureHome(remote.origin);
  token = await profile.secret("models");
  runtime = await profile.start();
});
after(async () => {
  const results = await Promise.allSettled([runtime?.stop(), remote?.close()]);
  await profile?.remove();
  for (const result of results) if (result.status === "rejected") throw result.reason;
});

function upgrade(extra: Record<string, string> = {}) {
  return new Promise<{
    status: number;
    headers: import("node:http").IncomingHttpHeaders;
    body: string;
    socket?: Duplex;
  }>((resolve, reject) => {
    const outgoing = request(`${runtime.origin}/v1/responses`, {
      headers: {
        authorization: `Bearer ${token}`,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        ...extra,
      },
    });
    outgoing.once("error", reject);
    outgoing.once("upgrade", (response, socket) => {
      socket.on("error", () => socket.destroy());
      resolve({ status: response.statusCode ?? 0, headers: response.headers, body: "", socket });
    });
    outgoing.once("response", (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      response.once("error", reject);
      response.once("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
      );
    });
    outgoing.end();
  });
}

test("an independent agent can compact its model conversation", { timeout: 10_000 }, async () => {
  const agent = independentAgent(
    `
    const response = await fetch(process.env.LOCAL_ORIGIN + "/v1/responses/compact", {
      method: "POST", headers: { authorization: "Bearer " + process.env.LOCAL_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture-model", input: [] }) });
    process.send({ status: response.status, body: await response.json() }); process.disconnect();
  `,
    runtime.origin,
    token,
  );
  assert.deepEqual(await agent.message(), { status: 200, body: { compacted: true } });
  assert.equal((await agent.exited).code, 0);
});

test(
  "a refused model WebSocket preserves the HTTP error and retry hint",
  { timeout: 10_000 },
  async () => {
    const result = await upgrade({ "openai-beta": "fixture-refuse" });
    result.socket?.destroy();
    assert.equal(result.status, 429);
    assert.equal(result.headers["retry-after"], "19");
    assert.equal(result.headers["content-type"], "application/json");
    assert.equal(result.headers["set-cookie"], undefined);
    assert.deepEqual(JSON.parse(result.body), { error: "synthetic handshake quota" });
  },
);

test(
  "a simultaneous upgrade burst cannot exceed the connection limit",
  { timeout: 10_000 },
  async () => {
    const results = await Promise.all(Array.from({ length: 48 }, () => upgrade()));
    try {
      const accepted = results.filter((result) => result.status === 101);
      assert.equal(accepted.length, 32, "Only 32 concurrent sessions may reach the model server.");
      assert.equal(results.filter((result) => result.status === 503).length, 16);
    } finally {
      await Promise.all(
        results.flatMap((result) =>
          result.socket
            ? [
                new Promise<void>((resolve) => {
                  result.socket!.once("close", () => resolve());
                  result.socket!.destroy();
                }),
              ]
            : [],
        ),
      );
    }
  },
);

for (const mode of ["unknown", "disconnect"]) test(`direct model ${mode} forbids retry without replaying the request`, async () => {
  const before = remote.modelCalls();
  const response = await fetch(`${runtime.origin}/v1/responses`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "fixture-model", mode }),
  });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-should-retry"), "false");
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(response.headers.get("retry-after-ms"), null);
  const body = await response.json() as { error: { code: string; retryable: boolean } };
  assert.equal(body.error.code, "upstream_outcome_unknown");
  assert.equal(body.error.retryable, false);
  assert.equal(remote.modelCalls(), before + 1);
});
