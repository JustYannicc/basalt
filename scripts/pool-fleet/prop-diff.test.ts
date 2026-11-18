import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { changedProps } from "./prop-diff.ts";

test("public diffs omit credentials, opaque tokens, hosts and arbitrary strings", () => {
  const before = {
    credentials: { name: "old-private-value" },
    bindings: [{ name: "old-private-value" }],
    name: "sk_abcdefghijklmnopqrstuvwxyz012345",
    context: "/private/path/to/context",
    description: "private text",
    password: Redacted.make("old-private-value"),
    version: 1,
  };
  const after = {
    credentials: { name: "new-private-value" },
    bindings: [{ name: "new-private-value" }],
    name: "ghp_abcdefghijklmnopqrstuvwxyz012345",
    context: "/other/private/path",
    description: "different private text",
    password: Redacted.make("new-private-value"),
    version: 2,
  };
  const changes = changedProps(before, after);
  assert.deepEqual(
    changes.filter((item) => "old" in item),
    [{ path: "version", old: 1, new: 2 }],
  );
  assert.equal(changes.length, 7);
  assert.ok(!JSON.stringify(changes).includes("private"));
});

test("safe image refs are capped, numeric additions are retained and removals are explicit", () => {
  const image = "registry.cloudflare.com/" + "public/".repeat(35) + "pool:latest";
  assert.deepEqual(changedProps({ image: "pool:old", count: 2 }, { image, size: 3 }), [
    { path: "count", old: 2, new: null },
    { path: "image", old: "pool:old", new: image.slice(0, 200) },
    { path: "size", old: null, new: 3 },
  ]);
});

test("unresolved expressions retain their path without hiding resolved sibling changes", () => {
  assert.deepEqual(
    changedProps({ version: 1 }, { env: { NAME: Effect.succeed("private") }, version: 2 }),
    [
      { path: "env.NAME", changed: true },
      { path: "version", old: 1, new: 2 },
    ],
  );
});

test("immutable registry digests remain visible while token-shaped names do not", () => {
  const prefix = "registry.cloudflare.com/" + "a".repeat(32) + "/pool@sha256:";
  assert.deepEqual(
    changedProps(
      { image: prefix + "a".repeat(64), name: "a".repeat(64) },
      { image: prefix + "b".repeat(64), name: "b".repeat(64) },
    ),
    [
      { path: "image", old: prefix + "a".repeat(64), new: prefix + "b".repeat(64) },
      { path: "name", changed: true },
    ],
  );
});

test("dynamic credential keys and private hostnames stay out of public diffs", () => {
  const old = {
    credentials: { abcdefghijklmnopqrstuvwx: 1 },
    name: "build-one.preview.example",
    hash: { input: "build-one.preview.example" },
    image: "private.registry.example/pool:old",
  };
  const next = {
    credentials: { abcdefghijklmnopqrstuvwx: 2 },
    name: "build-two.preview.example",
    hash: { input: "build-two.preview.example" },
    image: "private.registry.example/pool:new",
  };
  assert.deepEqual(changedProps(old, next), [
    { path: "credentials.[changed]", changed: true },
    { path: "hash.input", changed: true },
    { path: "image", changed: true },
    { path: "name", changed: true },
  ]);
});

test("an opaque image tag cannot bypass token redaction", () => {
  assert.deepEqual(
    changedProps({ image: "pool:old" }, { image: "pool:abcdefghijklmnopqrstuvwx" }),
    [{ path: "image", changed: true }],
  );
});

test("masking a private ancestor keeps its descendants private", () => {
  assert.deepEqual(
    changedProps(
      { extended_credentials_map_name: { name: "alice" } },
      { extended_credentials_map_name: { name: "bob" } },
    ),
    [{ path: "[changed].name", changed: true }],
  );
});
