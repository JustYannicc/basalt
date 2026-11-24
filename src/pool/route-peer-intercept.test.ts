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

test("the serving runtimes count as one image only when the root and every selected slot agree", () => {
  assert.equal(servesOneImage(["0123456789abcdef"], undefined), true);
  assert.equal(
    servesOneImage(["0123456789abcdef"], { epoch: 1, active: record("0123456789abcdef") }),
    true,
  );
  assert.equal(
    servesOneImage(["0123456789abcdef"], {
      epoch: 2,
      active: record("0123456789abcdef"),
      candidate: record("fedcba9876543210"),
    }),
    false,
  );
  assert.equal(
    servesOneImage(["0123456789abcdef"], {
      epoch: 3,
      active: record("0123456789abcdef"),
      draining: record("fedcba9876543210"),
    }),
    false,
  );
  assert.equal(
    servesOneImage(["0123456789abcdef"], { epoch: 4, active: record("fedcba9876543210") }),
    false,
  );
  // An unreadable selection is never taken as agreement.
  assert.equal(servesOneImage(["0123456789abcdef"], { epoch: "x" }), false);
});

test("the bound blue and green cell applications must run the root's image too", () => {
  const same = "0123456789abcdef";
  const other = "fedcba9876543210";
  const selection = { epoch: 1, active: record(same) };
  assert.equal(servesOneImage([same, same, same], selection), true);
  assert.equal(servesOneImage([same, undefined, undefined], selection), true);
  assert.equal(servesOneImage([same, other, undefined], selection), false);
  assert.equal(servesOneImage([same, same, other], selection), false);
  assert.equal(servesOneImage([undefined], undefined), false);
});
