import assert from "node:assert/strict";
import { test } from "node:test";
import { servingImage } from "./route-peer-intercept.ts";

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
  const root = "1111111111111111";
  assert.equal(servingImage(root, undefined), root);
  assert.equal(servingImage("", undefined), null);
  assert.equal(servingImage(root, { epoch: 1, active: record(one) }), one);
  assert.equal(servingImage(root, { epoch: 2, active: record(one), candidate: record(two) }), null);
  assert.equal(servingImage(root, { epoch: 3, active: record(one), draining: record(two) }), null);
  assert.equal(
    servingImage(root, {
      epoch: 4,
      active: record(two),
      candidate: record(two),
      draining: record(two),
    }),
    two,
  );
  // An unreadable selection is never taken as agreement.
  assert.equal(servingImage(root, { epoch: "x" }), null);
});

test("a steady-state production fleet passes: one selected runtime, whatever image the root or the other colour runs", () => {
  // The root container keeps its pinned image and the previous colour stays bound to its old one;
  // neither takes management calls while a runtime is selected.
  assert.equal(
    servingImage("1111111111111111", { epoch: 9, active: record("0123456789abcdef") }),
    "0123456789abcdef",
  );
});
