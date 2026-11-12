// The Artifacts control plane is a fake of the binding's documented methods; its Git data plane
// is real `git http-backend` (miniflare's Artifacts binding is remote-only).
import assert from "node:assert/strict";
import { test } from "node:test";
import { storageFixture } from "./fixture.ts";
import { Effect } from "effect";
import { DriveRequestFailed } from "apps/contracts";
import { reply, vaultObject, type ArtifactsNamespace } from "./object.ts";
import { backend, git, token } from "./artifacts/test/backend.ts";

const namespace = (server: Awaited<ReturnType<typeof backend>>) => {
  const calls: string[] = [];
  let created = false;
  const artifacts: ArtifactsNamespace = {
    async create(name) {
      calls.push(`create:${name}`);
      if (created) throw new Error("ALREADY_EXISTS");
      created = true;
      return { remote: server.url };
    },
    async get(name) {
      calls.push(`get:${name}`);
      return {
        info: async () => ({ remote: server.url }),
        async createToken(scope, ttl) {
          calls.push(`token:${scope}:${ttl}`);
          return { plaintext: token, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
        },
        async readBlob(oid) {
          try {
            return new Blob([git(server.bare, "cat-file", "blob", oid)]);
          } catch {
            return null;
          }
        },
      };
    },
  };
  return { artifacts, calls };
};

test("the vault object answers drive commands as JSON and writes its repository", async () => {
  const server = await backend();
  const data = storageFixture();
  try {
    const { artifacts, calls } = namespace(server);
    const object = vaultObject({
      app: "App_1",
      storage: data.storage,
      bucket: data.bucket,
      artifacts,
    });
    const info = await object.request({ operation: "drive", method: "list", input: {} });
    assert.equal(info.ok, true, JSON.stringify(info));
    const root = String(git(server.bare, "rev-parse", "main")).trim();
    const written = await object.request({
      operation: "drive",
      method: "apply",
      input: { base: root, operation: "first", edits: [{ path: "note.md", content: "hello" }] },
    });
    assert.equal(written.ok, true, JSON.stringify(written));
    assert.equal(git(server.bare, "show", "main:note.md").toString(), "hello");
    assert.deepEqual(calls.slice(0, 1), ["create:vault-app_1"]);
    // The token is minted once per hour and never part of a reply.
    assert.equal(calls.filter((call) => call.startsWith("token:write:3600")).length, 1);
    assert.ok(!JSON.stringify([info, written]).includes(token.split("?")[0]!));

    const refused = await object.request({
      operation: "drive",
      method: "no-such-method",
      input: {},
    });
    assert.deepEqual(refused, {
      ok: false,
      error: { _tag: "DriveRequestFailed", reason: "invalid_request" },
    });

    // A second object over the same storage finds the existing repository and its history.
    const again = vaultObject({
      app: "App_1",
      storage: data.storage,
      bucket: data.bucket,
      artifacts,
    });
    const read = await again.request({
      operation: "drive",
      method: "read",
      input: { path: "note.md" },
    });
    assert.equal(read.ok && (read.value as { content: string }).content, "hello");
  } finally {
    data.close();
    await server.close();
  }
});

test("a drive failure is a reply, but a defect propagates instead of hiding as outcome_unknown", async () => {
  assert.deepEqual(await reply(Effect.succeed({ done: true })), {
    ok: true,
    value: { done: true },
  });
  const failed = await reply(Effect.fail(new DriveRequestFailed({ reason: "denied" })));
  assert.equal(failed.ok, false);
  assert.equal(!failed.ok && failed.error.reason, "denied");
  await assert.rejects(
    reply(Effect.die(new Error("storage invariant broken"))),
    /storage invariant broken/,
  );
});

test("vaultObject.request rejects dispatcher defects", async (t) => {
  const server = await backend(),
    data = storageFixture();
  t.after(() => server.close());
  t.after(() => data.close());
  const { artifacts } = namespace(server);
  const object = vaultObject(
    { app: "defect", storage: data.storage, bucket: data.bucket, artifacts },
    () => () => Effect.die(new Error("request dispatcher invariant broken")),
  );
  await assert.rejects(
    object.request({ operation: "drive", method: "list", input: {} }),
    /request dispatcher invariant broken/,
  );
});

test("a vault written by an old plugin has per-note history and a last change, with the server's times", async (t) => {
  const server = await backend(),
    data = storageFixture();
  t.after(() => server.close());
  t.after(() => data.close());
  const { artifacts } = namespace(server);
  const object = vaultObject({
    app: "old-plugin",
    storage: data.storage,
    bucket: data.bucket,
    artifacts,
  });
  // An old plugin sends ordinary drive commands and nothing else.
  assert.equal((await object.request({ operation: "drive", method: "list", input: {} })).ok, true);
  let base = String(git(server.bare, "rev-parse", "main")).trim();
  const write = async (operation: string, edits: { path: string; content: string }[]) => {
    const landed = await object.request({
      operation: "drive",
      method: "apply",
      input: { base, operation, edits },
    });
    assert.equal(landed.ok, true, JSON.stringify(landed));
    base = (landed as { value: { oid: string } }).value.oid;
    return base;
  };
  const first = await write("one", [
    { path: "daily/a.md", content: "v1" },
    { path: "b.md", content: "b" },
  ]);
  await write("two", [{ path: "b.md", content: "b2" }]);
  const third = await write("three", [{ path: "daily/a.md", content: "v2" }]);

  const history = await object.request({
    operation: "drive",
    method: "history",
    input: { path: "daily/a.md" },
  });
  assert.equal(history.ok, true, JSON.stringify(history));
  const versions = (history as { value: { oid: string; time: string }[] }).value;
  assert.deepEqual(
    versions.map((v) => v.oid),
    [third, first],
    "only commits that changed the note",
  );
  for (const version of versions)
    assert.equal(
      version.time,
      new Date(
        Number(String(git(server.bare, "show", "-s", "--format=%at", version.oid)).trim()) * 1000,
      ).toISOString(),
    );
  const all = (await object.request({ operation: "drive", method: "history", input: {} })) as {
    value: { oid: string }[];
  };
  assert.equal(all.value[0]?.oid, third);
  const devices = (await object.request({ operation: "drive", method: "devices", input: {} })) as {
    value: { head: string; lastChangeAt: string; devices: unknown[] };
  };
  assert.equal(devices.value.head, third);
  assert.equal(devices.value.lastChangeAt, versions[0]!.time);
  assert.deepEqual(devices.value.devices, [], "no device grant has called yet");
});

test("each device grant's last sync and head are recorded from its own sync calls", async (t) => {
  const server = await backend(),
    data = storageFixture();
  t.after(() => server.close());
  t.after(() => data.close());
  const { artifacts } = namespace(server);
  let clock = Date.parse("2026-11-12T10:00:00Z");
  const object = vaultObject({
    app: "devices",
    storage: data.storage,
    bucket: data.bucket,
    artifacts,
    now: () => clock,
  });
  const mac = JSON.stringify(["user", "client-mac", "org", "grant-mac"]),
    phone = JSON.stringify(["user", "client-phone", "org", "grant-phone"]);
  await object.request({ operation: "drive", method: "list", input: {} }, mac);
  clock += 1000;
  await object.request({ operation: "drive", method: "list", input: {} }, phone);
  const root = String(git(server.bare, "rev-parse", "main")).trim();
  clock += 1000;
  const landed = (await object.request(
    {
      operation: "drive",
      method: "apply",
      input: { base: root, operation: "mac-edit", edits: [{ path: "n.md", content: "x" }] },
    },
    mac,
  )) as { value: { oid: string } };
  // A caller without a grant, or a call that saw no revision, records nothing.
  await object.request({ operation: "drive", method: "list", input: {} }, "not-a-caller");
  await object.request(
    { operation: "drive", method: "receipt", input: { operation: "mac-edit" } },
    phone,
  );

  const { value } = (await object.request({
    operation: "drive",
    method: "devices",
    input: {},
  })) as {
    value: { head: string; devices: { agent: string; lastSyncAt: string; lastHead: string }[] };
  };
  assert.equal(value.head, landed.value.oid);
  assert.deepEqual(value.devices, [
    { agent: "grant-mac", lastSyncAt: "2026-11-12T10:00:02.000Z", lastHead: landed.value.oid },
    { agent: "grant-phone", lastSyncAt: "2026-11-12T10:00:01.000Z", lastHead: root },
  ]);
  // Up to date means the device has seen the current head: the Mac has, the phone hasn't.
  assert.deepEqual(
    value.devices.map((d) => d.lastHead === value.head),
    [true, false],
  );
});
