import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverCandidateSettings } from "../architecture/native-stack.ts";

for (const mode of ["release-state-v7", "release-state-v8"] as const)
  test(`the actual release State gate handles ${mode} before native initialization`, () => {
    const result = discoverCandidateSettings(process.cwd(), mode);
    assert.ok(
      typeof result === "object" &&
        result !== null &&
        "ok" in result &&
        "enteredState" in result &&
        "stateRequests" in result,
    );
    assert.equal(result.ok, mode === "release-state-v8", JSON.stringify(result));
    assert.equal(result.enteredState, mode === "release-state-v8");
    assert.ok(
      (result.stateRequests as { method: string }[]).every((request) => request.method === "GET"),
    );
    if (mode === "release-state-v7") {
      assert.deepEqual(result, {
        ok: false,
        enteredState: false,
        reason: "release-state-version-requires-explicit-upgrade",
        delta: {
          fqn: "AlchemyStateStore",
          type: "Alchemy.State",
          changed: [{ path: "version", old: 7, new: 8 }],
        },
        stateRequests: [{ method: "GET", path: "/version" }],
      });
    }
  });
