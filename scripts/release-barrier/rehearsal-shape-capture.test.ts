import assert from "node:assert/strict";
import { test } from "node:test";
import { installShapeCapture, shapeOf } from "./rehearsal-shape-capture.ts";

test("a captured shape keeps key names and types, enum-like states and workers/ annotations, never ids or values", () => {
  assert.deepEqual(
    shapeOf({
      id: "a03d2cdf-0660-4128-812c-bdbbea7be67c",
      status: "pending",
      state: "0123456789abcdef0123456789abcdef",
      configuration: { vcpu: 1, memory: "4GiB", command: [], disk: { size_mb: 1 } },
      annotations: { "workers/message": "rehearsal marker", "workers/triggered_by": "upload" },
      result_info: null,
    }),
    {
      id: "string",
      status: "string:pending",
      state: "string",
      configuration: {
        vcpu: "number",
        memory: "string",
        command: "empty-array",
        disk: { size_mb: "number" },
      },
      annotations: {
        "workers/message": "string:rehearsal marker",
        "workers/triggered_by": "string:upload",
      },
      result_info: "null",
    },
  );
});

test("the capture installs nothing on production or without a capture directory", () => {
  const before = globalThis.fetch;
  assert.equal(
    installShapeCapture({ ALCHEMY_STAGE: "production", BASALT_REHEARSAL_CAPTURE_DIR: "/tmp/x" }),
    false,
  );
  assert.equal(installShapeCapture({ BASALT_REHEARSAL_CAPTURE_DIR: "/tmp/x" }), false);
  assert.equal(installShapeCapture({ ALCHEMY_STAGE: "test-rehearsal-7" }), false);
  assert.equal(globalThis.fetch, before);
});
