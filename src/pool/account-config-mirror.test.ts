import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import {
  handleAccountKeyMirror,
  accountMirrorPath,
  accountMirrorPrefix,
} from "./account-key-mirror.ts";
import { signEnvelope } from "./token.ts";

const signingKey = "ab".repeat(32);
const first = "12345678-abcd-4000-8000-000000000001";
const second = "12345678-abcd-4000-8000-000000000002";
const now = 1_800_000_000_000;
const credential = {
  type: "config",
  family: "codex",
  group: { "base-url": "https://api.openai.com/v1" },
  token: "synthetic-key",
};
async function invoke(
  home: HomeClient,
  reference: string,
  action: string,
  config: Record<string, unknown> = credential,
) {
  const envelope = await signEnvelope(signingKey, accountMirrorPrefix, {
    at: now,
    expiresAt: now + 10_000,
    reference,
    action,
    credential: config,
  });
  return handleAccountKeyMirror(
    new Request(`https://pool.example${accountMirrorPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
    { home, signingKey, now: () => now },
  );
}
function fixture() {
  let groups: Record<string, unknown>[] = [
    {
      name: "existing",
      keys: [{ id: "retained", "api-key": "retained-synthetic-key", priority: 5 }],
    },
  ];
  let writes = 0;
  let loseReply = false;
  let rejectWrite = false;
  const home = new HomeClient(async (path, init) => {
    assert.equal(path, "/v8/management/config/api-keys/codex");
    if (init?.method === "PUT") {
      writes++;
      if (rejectWrite) return new Response(null, { status: 503 });
      groups = JSON.parse(String(init.body));
      if (loseReply) throw new Error("synthetic lost reply");
      return Response.json({ status: "ok" });
    }
    return Response.json(groups);
  });
  return {
    home,
    groups: () => groups,
    writes: () => writes,
    loseReply: () => {
      loseReply = true;
    },
    rejectWrite: () => {
      rejectWrite = true;
    },
  };
}

test("concurrent config mirrors retain other accounts and exact assigned IDs across retry and removal", async () => {
  const f = fixture();
  const responses = await Promise.all([
    invoke(f.home, first, "upsert"),
    invoke(f.home, second, "upsert"),
  ]);
  assert.deepEqual(
    responses.map((r) => r.status),
    [200, 200],
  );
  const original = f.groups()[0];
  assert.deepEqual(original, {
    name: "existing",
    keys: [{ id: "retained", "api-key": "retained-synthetic-key", priority: 5 }],
  });
  assert.equal(f.groups().length, 3);
  assert.equal((await invoke(f.home, first, "upsert")).status, 200);
  assert.equal(f.groups().length, 3);
  assert.equal(f.writes(), 2);
  assert.equal((await invoke(f.home, first, "remove")).status, 200);
  assert.equal((await invoke(f.home, first, "remove")).status, 200);
  assert.equal(f.groups().length, 2);
  assert.deepEqual(f.groups()[0], original);
  assert.equal(JSON.stringify(f.groups()).includes(second), true);
  assert.equal(JSON.stringify(f.groups()).includes(first), false);
});

test("lost write replies resolve only after matching readback and rejected writes stay unacknowledged", async () => {
  const uncertain = fixture();
  uncertain.loseReply();
  assert.equal((await invoke(uncertain.home, first, "upsert")).status, 200);
  const rejected = fixture();
  rejected.rejectWrite();
  assert.equal((await invoke(rejected.home, first, "upsert")).status, 503);
  assert.equal(rejected.groups().length, 1);
});

test("config credentials cannot override their assigned ID or choose unknown families", async () => {
  const f = fixture();
  assert.equal(
    (await invoke(f.home, first, "upsert", { ...credential, family: "unsupported" })).status,
    503,
  );
  assert.equal(f.writes(), 0);
  const r = await invoke(f.home, first, "upsert", {
    ...credential,
    group: { ...credential.group, keys: [] },
  });
  assert.equal(r.status, 503);
  assert.equal(f.writes(), 0);
});

test("an unrelated empty config group survives mirroring and removal", async () => {
  const empty = { name: "retained-empty", keys: [], "base-url": "https://retained.example.test" };
  let groups = [empty];
  const home = new HomeClient(async (_path, init) => {
    if (init?.method === "PUT") {
      groups = JSON.parse(String(init.body));
      return Response.json({ status: "ok" });
    }
    return Response.json(groups);
  });
  assert.equal((await invoke(home, first, "upsert")).status, 200);
  assert.deepEqual(groups[0], empty);
  assert.equal((await invoke(home, first, "remove")).status, 200);
  assert.deepEqual(groups, [empty]);
});
