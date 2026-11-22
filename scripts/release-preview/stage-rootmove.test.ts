import assert from "node:assert/strict";
import { test } from "node:test";
import { fingerprint } from "./stage-probe.ts";
import {
  instanceFacts,
  readRootApplication,
  rootMoveVerdict,
  type RootRead,
} from "./stage-rootmove.ts";

const read = (version: number, ...instances: [string, string][]): RootRead => ({
  version,
  instances: instances.map(([id, state]) => ({ id, state, versions: {} })),
});

test("the root held its instance only if one ran before, it still runs, and the boot never moved", () => {
  const before = read(1, ["i", "running"]);
  assert.deepEqual(
    rootMoveVerdict({ before, after: read(2, ["i", "running"]), rootChanged: false }),
    {
      versionMoved: true,
      sameRunningInstance: true,
      bootUnchanged: true,
      a: true,
      c: true,
    },
  );
  // A rolled instance: a new one runs, or the boot changed.
  const rolled = rootMoveVerdict({
    before,
    after: read(2, ["i", "stopped"], ["j", "running"]),
    rootChanged: true,
  });
  assert.equal(rolled.a, false);
  assert.equal(rolled.c, false);
  // No new version: the move did not happen, so it proves nothing about (a).
  assert.equal(
    rootMoveVerdict({ before, after: read(1, ["i", "running"]), rootChanged: false }).a,
    false,
  );
  // Two running before, or none: no single instance to follow.
  for (const ambiguous of [read(1, ["i", "running"], ["j", "running"]), read(1)])
    assert.equal(
      rootMoveVerdict({ before: ambiguous, after: read(2, ["i", "running"]), rootChanged: false })
        .c,
      false,
    );
});

test("an instance is reported by its hashed id, its state and the version fields it states", () => {
  assert.deepEqual(
    instanceFacts({
      id: "instance-raw-id",
      status: { state: "running" },
      application_version: 2,
      location: "a-place",
    }),
    { id: fingerprint("instance-raw-id"), state: "running", versions: { application_version: 2 } },
  );
  assert.deepEqual(instanceFacts(null), { id: null, state: null, versions: {} });
});

test("the read finds the root by name, pages its instances and never names an id", async () => {
  const requests: string[] = [];
  const send: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    const ok = (result: unknown, info: unknown = {}) =>
      Response.json({ success: true, result, result_info: info });
    if (url.pathname.endsWith("/containers/applications"))
      return ok([
        { id: "other", name: "someone-else", version: 9 },
        { id: "app-raw", name: "root", version: 3 },
      ]);
    if (!url.searchParams.has("page_token"))
      return ok([{ id: "one", status: { state: "running" } }], { next_page_token: "p2" });
    return ok([{ id: "two", status: { state: "stopped" } }]);
  };
  const root = await readRootApplication(
    { accountId: "a".repeat(32), token: "t", name: "root" },
    send,
  );
  assert.equal(root.version, 3);
  assert.deepEqual(
    root.instances.map(({ id, state }) => ({ id, state })),
    [
      { id: fingerprint("one"), state: "running" },
      { id: fingerprint("two"), state: "stopped" },
    ],
  );
  assert.ok(requests.some((path) => path.includes("/app-raw/instances-v2")));
  assert.doesNotMatch(JSON.stringify(root), /app-raw|"one"|"two"/u);
  await assert.rejects(
    readRootApplication({ accountId: "a".repeat(32), token: "t", name: "absent" }, send),
    /not in the account's list/u,
  );
});
