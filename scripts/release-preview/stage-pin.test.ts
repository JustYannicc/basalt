import assert from "node:assert/strict";
import { test } from "node:test";
import { managedReference } from "./rehearsal-native-hooks.ts";
import { composeRootPin } from "./stage-pin.ts";

const account = "0".repeat(32);
const parts = (patch: Record<string, string> = {}) =>
  JSON.stringify({
    repository: "basalt-poolcontainer-production-abc",
    digest: `sha256:${"e".repeat(64)}`,
    input: "526fa60bed0df442",
    ...patch,
  });

test("composeRootPin is absent when the lane has no root image", () => {
  assert.equal(composeRootPin(undefined, account), undefined);
  assert.equal(composeRootPin("  ", account), undefined);
});

test("composeRootPin composes a digest reference the fleet pin keeps as it is", () => {
  const pin = JSON.parse(composeRootPin(parts(), account)!) as { image: string; input: string };
  assert.equal(pin.input, "526fa60bed0df442");
  assert.deepEqual(managedReference(pin.image), { kind: "digest", reference: pin.image });
});

test("composeRootPin refuses a short digest, a bad input, a tag, or a missing account", () => {
  assert.throws(() => composeRootPin(parts({ digest: "sha256:ed541640" }), account));
  assert.throws(() => composeRootPin(parts({ input: "526fa60b" }), account));
  assert.throws(() => composeRootPin(parts({ repository: "repo:latest" }), account));
  assert.throws(() => composeRootPin(parts(), undefined), /account id/u);
  assert.throws(() => composeRootPin("not json", account));
});
