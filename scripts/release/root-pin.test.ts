import assert from "node:assert/strict";
import { test } from "node:test";
import { rootPinMismatch } from "./root-pin.ts";

const image = `registry.cloudflare.com/${"0".repeat(32)}/pool-root@sha256:${"e".repeat(64)}`;
const input = "0123456789abcdef";
const rootRow = { attr: { configuration: { image }, hash: { image: "a".repeat(16) } } };
const workerRow = { props: { env: { POOL_IMAGE_HASH: input } } };
const pin = (value: object) => JSON.stringify(value);

test("the preflight admits only the pin State records the root running", () => {
  assert.equal(rootPinMismatch(pin({ image, input }), rootRow, workerRow), undefined);
  // Unset, unreadable, or naming nothing State records.
  assert.equal(rootPinMismatch(undefined, rootRow, workerRow), "POOL_ROOT_IMAGE is not set");
  assert.equal(rootPinMismatch("", rootRow, workerRow), "POOL_ROOT_IMAGE is not set");
  assert.equal(rootPinMismatch("{", rootRow, workerRow), "POOL_ROOT_IMAGE is not JSON");
  assert.match(
    rootPinMismatch(pin({ image, input }), undefined, workerRow) ?? "",
    /no root image/u,
  );
  // Another digest, a tag, or another build input than the controller knows the root by.
  const other = image.replace(/e{64}$/u, "f".repeat(64));
  const tag = image.replace(/@sha256:e{64}$/u, ":latest");
  for (const wrong of [other, tag])
    assert.match(
      rootPinMismatch(pin({ image: wrong, input }), rootRow, workerRow) ?? "",
      /image differs .* input equal/u,
    );
  assert.match(
    rootPinMismatch(pin({ image, input: "fedcba9876543210" }), rootRow, workerRow) ?? "",
    /image equal .* input differs/u,
  );
  // The pinned row's own hash names the reference, not the build: it is never the input.
  assert.match(
    rootPinMismatch(pin({ image, input: "a".repeat(16) }), rootRow, workerRow) ?? "",
    /input differs/u,
  );
});
