import assert from "node:assert/strict";
import { test } from "node:test";
import { managedReference } from "./rehearsal-native-hooks.ts";

const account = "0".repeat(32);
const digest = `sha256:${"a".repeat(64)}`;

test("managedReference keeps a digest reference as it is", () => {
  const reference = `registry.cloudflare.com/${account}/basalt-poolcontainer-x@${digest}`;
  assert.deepEqual(managedReference(reference), { kind: "digest", reference });
});

test("managedReference splits a tagged reference into repository and tag", () => {
  assert.deepEqual(
    managedReference(`registry.cloudflare.com/${account}/basalt-rehearsal-poolcontainer:abc123`),
    { kind: "tag", repository: `${account}/basalt-rehearsal-poolcontainer`, tag: "abc123" },
  );
});

test("managedReference refuses anything outside the managed registry or a short digest", () => {
  assert.throws(() => managedReference(`docker.io/library/alpine@${digest}`), /tag or digest/u);
  assert.throws(
    () => managedReference(`registry.cloudflare.com/${account}/repo@sha256:${"a".repeat(12)}`),
    /tag or digest/u,
  );
});
