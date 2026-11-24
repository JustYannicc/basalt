import assert from "node:assert/strict";
import { test } from "node:test";
import { servesOneImage } from "./route-peer-intercept.ts";

const target = (imageInput: string) => ({
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: "slot",
  applicationId: "application",
  applicationVersion: "1",
  instanceId: "instance",
  imageDigest: "sha256:" + "a".repeat(64),
  imageInput,
});
const record = (imageInput: string) => ({ target: target(imageInput), fenced: false });

test("the reachable runtimes count as one image only when the selection's active, candidate and draining agree", () => {
  const one = "0123456789abcdef";
  const two = "fedcba9876543210";
  assert.equal(servesOneImage(undefined), true);
  assert.equal(servesOneImage({ epoch: 1, active: record(one) }), true);
  assert.equal(servesOneImage({ epoch: 2, active: record(one), candidate: record(two) }), false);
  assert.equal(servesOneImage({ epoch: 3, active: record(one), draining: record(two) }), false);
  assert.equal(
    servesOneImage({
      epoch: 4,
      active: record(two),
      candidate: record(two),
      draining: record(two),
    }),
    true,
  );
  // An unreadable selection is never taken as agreement.
  assert.equal(servesOneImage({ epoch: "x" }), false);
});

test("a steady-state production fleet passes: one selected runtime, whatever image the root or the other colour runs", () => {
  // The root container keeps its pinned image and the previous colour stays bound to its old one;
  // neither takes management calls while a runtime is selected.
  assert.equal(servesOneImage({ epoch: 9, active: record("0123456789abcdef") }), true);
});
