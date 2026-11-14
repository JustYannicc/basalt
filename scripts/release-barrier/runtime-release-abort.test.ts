import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeReleaseClientFixture } from "./test/runtime-release-client-fixture.ts";
import { runtimeFixtureCode } from "../pool-tests/runtime-handoff-proofs.ts";
import { runtimeConfiguration } from "../../src/pool/runtime-slots/configuration.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { runRuntimeAbort } from "./runtime-release-abort.ts";

for (const lost of ["none", "before", "after"] as const)
  test(`the release abort plans before writing and recovers a ${lost} stop reply through inspection only`, async (context) => {
    const f = await runtimeReleaseClientFixture("public");
    context.after(f.cleanup);
    await assert.rejects(f.client.promote("green-application", "abort-release", f.claims.pool));
    let record: RuntimeReleaseRecord = {
      format: "pool-image-release-v1",
      candidate: runtimeFixtureCode.candidate,
      complete: false,
      baseline: f.state,
      desiredInput: f.candidate.target.imageInput,
      desiredConfiguration: runtimeConfiguration(f.candidate.env),
      bootstrap: {},
      configurations: {},
      promotion: f.attempts.at(-1),
    };
    let sends = 0,
      writes = 0;
    const client = {
      ...f.client,
      call: async (...args: Parameters<typeof f.client.call>) => {
        if (args[0].action === "startup-abort") {
          sends++;
          assert.equal(record.abort?.sent, true);
          if (lost === "before") throw new Error("synthetic unknown pre-dispatch");
          const response = await f.client.call(...args);
          if (lost === "after") throw new Error("synthetic lost abort reply");
          return response;
        }
        return f.client.call(...args);
      },
    };
    const save = async (next: RuntimeReleaseRecord) => {
      writes++;
      record = structuredClone(next);
    };
    const plan = await runRuntimeAbort({ record, client, save, mode: "plan" });
    assert.equal(writes, 0);
    assert.equal(sends, 0);
    await assert.rejects(
      runRuntimeAbort({ record, client, save, mode: "0".repeat(64) }),
      /provisioning-input-drift/,
    );
    assert.equal(writes, 0);
    const receipt = await runRuntimeAbort({ record, client, save, mode: plan.fingerprint! });
    assert.equal(receipt.status, lost === "before" ? "pending" : "aborted");
    assert.equal(record.abort?.status, receipt.status);
    await runRuntimeAbort({ record, client, save, mode: "inspect" });
    await runRuntimeAbort({ record, client, save, mode: plan.fingerprint! });
    assert.equal(sends, 1);
    const stopped = [...f.instances.values()][0]!.fixture;
    assert.equal(stopped.calls.destroy, lost === "before" ? 0 : 1);
    assert.equal(f.old.calls.destroy, 0);
    assert.equal(
      (await f.client.inspect()).selection?.active.identity?.bootId,
      f.old.identity().bootId,
    );
  });
