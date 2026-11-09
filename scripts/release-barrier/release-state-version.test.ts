import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverCandidateSettings } from "../architecture/native-stack.ts";

for (const mode of ["release-state-v7", "release-state-v8", "forward-state-v7"] as const)
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
    if (mode !== "release-state-v8") {
      assert.ok(
        "failure" in result &&
          "logs" in result &&
          "summary" in result &&
          "reason" in result &&
          "delta" in result,
      );
      const expected = {
        phase: mode === "forward-state-v7" ? "forward-probe" : "release",
        expected: 8,
        observed: 7,
      };
      const failure = result.failure as {
        reason: string;
        phase: string;
        stateStore: unknown;
        activated: unknown[];
      };
      assert.equal(failure.reason, "state-store-version");
      assert.equal(failure.phase, "preparation");
      assert.deepEqual(failure.stateStore, expected);
      assert.deepEqual(failure.activated, []);
      const rendered = [...(result.logs as string[]), result.summary].join("\n");
      assert.match(rendered, /state-store-version/);
      assert.match(rendered, /expected=8; observed=7/);
      assert.ok(rendered.includes(`phase=${expected.phase}`));
      assert.deepEqual(
        {
          ok: result.ok,
          enteredState: result.enteredState,
          reason: result.reason,
          delta: result.delta,
          stateRequests: result.stateRequests,
        },
        {
          ok: false,
          enteredState: false,
          reason: "state-store-version",
          delta: {
            fqn: "AlchemyStateStore",
            type: "Alchemy.State",
            changed: [{ path: "version", old: 7, new: 8 }],
          },
          stateRequests: [{ method: "GET", path: "/version" }],
        },
      );
    }
  });
