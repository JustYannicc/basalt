import { PoolRuntimeUnhealthy } from "./lifecycle.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { homeReferences } from "./home-references.ts";
import { fixture, body, owner } from "./test/account-acquisition.ts";

test("a global sign-in retains exact project IDs across restart without attaching a pool", async () => {
  const f = fixture();
  const started = await body(await f.send("start"));
  assert.equal(typeof started.session, "string");
  assert.deepEqual(await body(await f.send("start")), started);
  assert.equal(f.calls.filter((call) => call.path.includes("/oauth/auth-url")).length, 1);
  f.complete(["parent", "project-a", "project-b"]);
  const connected = await body(await f.send("status", { session: started.session }));
  assert.equal(connected.state, "connected");
  assert.equal(typeof connected.ref, "string");
  assert.deepEqual(homeReferences(String(connected.ref)), ["parent", "project-a", "project-b"]);
  assert.equal(f.markers.size, 0);
  assert.deepEqual([...f.excluded].sort(), ["parent", "project-a", "project-b"]);
  assert.equal(
    f.calls.some((call) => call.method === "POST" && call.path.includes("channel-group")),
    false,
  );
  f.restart();
  const before = f.calls.length;
  assert.deepEqual(await body(await f.send("status", { session: started.session })), connected);
  assert.equal(f.calls.length, before);
  assert.equal(
    (await f.send("status", { session: started.session }, "organization:another")).status,
    503,
  );
});

test("an unsigned request cannot warm Home or mutate acquisition state", async () => {
  const f = fixture();
  assert.equal((await f.unsigned()).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(f.markers.size, 0);
});

test("an uncertain start is retained and never repeated after eviction", async () => {
  const f = fixture();
  f.loseStart();
  assert.equal((await f.send("start")).status, 503);
  f.restart();
  assert.equal((await f.send("start")).status, 503);
  assert.equal(f.calls.filter((call) => call.path.includes("/oauth/auth-url")).length, 1);
  assert.equal(f.markers.size, 1);
});

test("a new connection cannot claim a credential that existed before sign-in", async () => {
  const f = fixture(["saved"]);
  const started = await body(await f.send("start"));
  f.complete(["saved"]);
  const failed = await body(await f.send("status", { session: started.session }));
  assert.equal(failed.state, "failed");
  await f.send("cancel", { session: started.session });
  assert.deepEqual([...f.credentials], ["saved"]);
  assert.equal(
    f.calls.some((call) => call.method === "DELETE" && call.path.includes("credentials")),
    false,
  );
});

test("failed-save cancellation retires only fresh credentials and preserves a reconnect", async () => {
  const f = fixture(["saved"]);
  const started = await body(await f.send("start", { reconnect: "saved" }));
  f.complete(["saved", "fresh"]);
  assert.equal(
    (await body(await f.send("status", { session: started.session }))).state,
    "connected",
  );
  assert.equal((await f.send("cancel", { session: started.session })).status, 200);
  assert.deepEqual([...f.credentials], ["saved"]);
  assert.equal(
    f.calls.filter((call) => call.method === "DELETE" && call.path.includes("credentials")).length,
    1,
  );
});

test("cancellation refuses to delete a credential already linked to a pool", async () => {
  const f = fixture();
  const started = await body(await f.send("start"));
  f.complete(["fresh"]);
  await f.send("status", { session: started.session });
  f.members.add("fresh");
  assert.equal((await f.send("cancel", { session: started.session })).status, 503);
  assert.deepEqual([...f.credentials], ["fresh"]);
});

test("a status outage returns a closed receipt and keeps the same attempt recoverable", async () => {
  const f = fixture();
  const started = await body(await f.send("start"));
  for (const [error, errorClass] of [
    [new Error("private credential must never escape"), "transport"],
    [new PoolRuntimeUnhealthy(), "runtime_unhealthy"],
    [new DOMException("private timeout detail", "TimeoutError"), "timeout"],
  ] as const) {
    f.failStatus(error);
    const unavailable = await f.send("status", { session: started.session });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), {
      error: "acquisition_unavailable",
      receipt: { phase: "oauth_status", errorClass, retryable: true },
    });
  }
  f.restart();
  f.failStatus();
  f.complete(["recovered"]);
  assert.equal(
    (await body(await f.send("status", { session: started.session }))).state,
    "connected",
  );
});

test("saved removal needs a host acting person and never borrows its organization owner", async () => {
  for (const actor of [undefined, "organization:fixture", "person"]) {
    const f = fixture(["saved"]);
    f.members.add("saved");
    const response = await f.send(
      "remove",
      { reference: "saved", ...(actor === undefined ? {} : { actor }) },
      owner,
      "remove-operation",
    );
    assert.equal(response.status, 200);
    assert.equal(f.credentials.has("saved"), false);
    assert.deepEqual(
      f.acknowledgements,
      actor === "person"
        ? [{ pool: "pool", references: ["saved"], actor: "person", operation: "remove-operation" }]
        : [],
    );
  }
});
