// The Artifacts control plane is a fake of the binding's documented methods; its Git data plane
// is real `git http-backend` (miniflare's Artifacts binding is remote-only).
import assert from "node:assert/strict";
import { test } from "node:test";
import { storageFixture } from "./fixture.ts";
import { vaultObject, type ArtifactsNamespace } from "./object.ts";
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
