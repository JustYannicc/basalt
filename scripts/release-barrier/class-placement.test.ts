import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { classProvisioning } from "./test/declared-class-fixture.ts";

for (const companion of ["numeric", "repair"] as const)
  test(`class provisioning preserves an ordinary Worker's ${companion} placement admission`, async () => {
    const proof = classProvisioning({ companion });
    await Effect.runPromise(proof.effect);
    assert.deepEqual(proof.failures, []);
    assert.equal(proof.events.filter((event) => event === "expand").length, 1);
    assert.ok(proof.events.indexOf("expand") < proof.events.indexOf("upload"));
    assert.ok(proof.events.indexOf("upload") < proof.events.indexOf("create-bucket"));
    assert.ok(proof.events.indexOf("create-bucket") < proof.events.indexOf("companion-activate"));
    if (companion === "repair") {
      assert.ok(proof.events.includes("repair-settings:before"));
      assert.ok(proof.events.includes("repair-settings:after"));
    }
  });

for (const [companion, reason] of [
  ["numeric-drift", /script-settings-drift/],
  ["retired", /pending-placement-repair-not-admitted/],
] as const)
  test(`class provisioning refuses ${companion} before any class or bucket mutation`, async () => {
    const proof = classProvisioning({ companion, expectedFailure: reason });
    await Effect.runPromise(proof.effect);
    assert.equal(proof.failures.length, 1);
    assert.equal(proof.cloneState().staged, 0);
    assert.ok(
      !proof.events.some((event) =>
        ["expand", "upload", "create-bucket", "companion-activate"].includes(event),
      ),
    );
  });
