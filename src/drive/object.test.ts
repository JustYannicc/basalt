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

test("without its attachment bucket a vault keeps text and history, and refuses every attachment command before the meter", async (t) => {
  const server = await backend(),
    data = storageFixture();
  t.after(() => server.close());
  t.after(() => data.close());
  const { artifacts } = namespace(server);
  const object = vaultObject({ app: "unbound", storage: data.storage, artifacts });
  const root = async () => {
    const listed = await object.request({ operation: "drive", method: "list", input: {} });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    return String(git(server.bare, "rev-parse", "main")).trim();
  };
  const base = await root();
  const written = await object.request({
    operation: "drive",
    method: "apply",
    input: { base, operation: "text", edits: [{ path: "note.md", content: "still here" }] },
  });
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.equal(git(server.bare, "show", "main:note.md").toString(), "still here");

  // Row counts of every table: quota, import budget, meter and Git state.
  const rows = () =>
    Object.fromEntries(
      [...data.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'")].map(
        ({ name }) => [
          String(name),
          Number([...data.storage.sql.exec(`SELECT COUNT(*) AS n FROM "${String(name)}"`)][0]?.n),
        ],
      ),
    );
  const before = rows();
  const hash = "a".repeat(64);
  const commands = {
    beginAttachment: { operation: "begin", oid: hash, bytes: 3 },
    uploadAttachmentPart: { upload: hash, part: 0, contentBase64: "AAAA" },
    completeAttachment: { upload: hash },
    cancelAttachment: { upload: hash },
    attach: { base, path: "paper.pdf", operation: "attach", oid: hash, bytes: 3 },
    attachment: { path: "paper.pdf" },
    planImport: { id: "import", page: 0, entries: [], final: true },
    importStatus: {},
    runImport: { id: "import", request: {} },
    finishImport: { id: "import" },
  };
  for (const [method, input] of Object.entries(commands))
    assert.deepEqual(
      await object.request({ operation: "drive", method, input }),
      {
        ok: false,
        error: {
          _tag: "DriveRequestFailed",
          reason: "unavailable",
          message: "Vault attachment storage is not provisioned yet",
        },
      },
      method,
    );
  // Nothing reached the meter, quota or import budget, so no write is left pending for a retry to
  // skip and no reservation outlives the refusal.
  assert.deepEqual(rows(), before);
  assert.equal(before.vault_stored_objects, 0);
  const read = await object.request({
    operation: "drive",
    method: "read",
    input: { path: "note.md" },
  });
  assert.equal(read.ok && (read.value as { content: string }).content, "still here");
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
