import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  gate,
  stuckFleet,
  unready,
  type Stuck,
} from "../../scripts/pool-tests/runtime-fleet-stuck-fixture.ts";
import { releasedCode } from "../../scripts/pool-tests/runtime-fleet-cell-fixture.ts";
import { handoffRuntime } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import {
  joinedRuntimeProof,
  runtimeGrant,
} from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { RuntimeSqlite } from "../../scripts/pool-tests/runtime-handoff-storage.ts";
import { startingBoundMs } from "./runtime-fleet/phase-bounds.ts";
import { codeAdoptionWindowMs } from "./runtime-slots/code-adoption.ts";
import { isLaunchAuthorization } from "./runtime-slots/admission-proof.ts";
import { RuntimeWitnessStore } from "./runtime-slots/witness-store.ts";
import { slotSelectionKey } from "./runtime-slots/storage.ts";

/**
 * A start under the fixture's code whose container is slow: its first readiness read is held. A
 * release lands while it is held, so the controller hands over to the released code and the
 * endpoint object keeps running the old one. The held read answers, the readiness reads after it
 * refuse until `healthy()`, so the old isolate's start ends without its attest, as the handover's
 * reset ends it on production. Without `deployed`, the platform still serves the object the old
 * code when it resets.
 */
async function startAcrossRelease(s: Stuck, { deployed = true } = {}) {
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  const boot = gate();
  let held = false;
  let slow = true;
  s.f.hooks.health = async () => {
    if (!held) {
      held = true;
      boot.reached();
      await boot.opened;
      return;
    }
    if (slow) return unready();
  };
  const starting = s.f.cell.start(s.f.target);
  await boot.arrived;
  if (deployed) s.f.deploy(releasedCode);
  s.replaceController(releasedCode);
  boot.open();
  await assert.rejects(starting, "the old isolate's start activated");
  assert.equal(s.f.calls.start, 1);
  assert.equal(s.f.ctx.container.running, true, "the container booted");
  const since = (await s.row())!.phaseAt!;
  return {
    since,
    healthy: () => {
      slow = false;
    },
  };
}

/**
 * Passes for `milliseconds`: the endpoint is asked to adopt and refuses for `held` alone, never
 * resets, and the cell is never admitted.
 */
async function neverAdopts(s: Stuck, held: string, milliseconds = 10_000) {
  const from = Date.now();
  while (Date.now() - from < milliseconds) {
    const row = await s.pass();
    assert.notEqual(row?.phase, "ready", "a start whose endpoint can't adopt was admitted");
  }
  const lines = s.adoptions();
  assert.notDeepEqual(lines, [], "the endpoint was never asked to adopt");
  assert.deepEqual(
    lines.map((line) => [line.outcome, line.held]),
    lines.map(() => ["refused", held]),
  );
  assert.deepEqual(s.f.calls.resets, [], "the endpoint reset");
}

test("a start in flight across a release adopts the controller's new code once and is admitted inside its bound", async (context) => {
  const s = await stuckFleet(context, { demand: 1 });
  const sent = (path: string) => s.f.transport.sent.filter((value) => value === path).length;
  const start = await startAcrossRelease(s);
  // Slow still: a pass reads its refusal, and nothing resets yet.
  let row = await s.pass();
  assert.ok(row?.phase === "warming" || row?.phase === "uncertain", `left as ${row?.phase}`);
  assert.deepEqual(s.f.calls.resets, [], "the endpoint reset before it was healthy");
  start.healthy();
  const refused = s.upkeepRefusals().length;
  let passes = 0;
  while ((row = await s.pass())?.phase !== "ready") {
    assert.notEqual(
      row?.phase,
      "quarantined",
      `the healthy cell was never admitted (${row?.reason}): ${sent("/witness")} witness reads, ${sent("/attest")} attests`,
    );
    assert.ok(Date.now() - start.since <= startingBoundMs, "not admitted inside its start bound");
    passes++;
  }
  assert.equal(s.f.calls.resets.length, 1, "not exactly one adoption");
  assert.deepEqual(
    s.adoptions().map((line) => line.outcome),
    ["resetting"],
  );
  assert.equal(passes, 1, `admitted only after ${passes + 1} healthy passes`);
  // The adopting answer reached the controller: a reset that overtook it would fail the read.
  assert.deepEqual(s.upkeepRefusals().slice(refused), ["slot_controller_code"]);
  // It serves: a model call reaches the cell, not the root.
  const before = s.rootCalls();
  assert.equal(await s.forward(), 200);
  assert.equal(s.rootCalls(), before, "the call went to the root");
  assert.notDeepEqual(s.f.transport.modelStubs, [], "no call reached the cell");
});

test("a start its endpoint attested never adopts, since the controller may have committed it", async (context) => {
  const s = await stuckFleet(context, { demand: 1 });
  await s.state.reserve(s.f.target);
  await s.state.dispatch(s.f.target);
  // The proof read after its attestation is refused, so the old isolate's activation ends with the
  // endpoint attested and no selection read back, as a controller reset between the two leaves it.
  let refusing = true;
  s.f.hooks.health = async () => (refusing && (await s.attested()) ? unready() : undefined);
  await assert.rejects(s.f.cell.start(s.f.target), "the old isolate's activation committed");
  assert.equal(await s.attested(), true, "the endpoint never attested");
  s.f.deploy(releasedCode);
  s.replaceController(releasedCode);
  refusing = false;
  await neverAdopts(s, "selection");
});

test("a start with a stream admitted at its endpoint never adopts, since the reset would cut it", async (context) => {
  const s = await stuckFleet(context, { demand: 1 });
  const start = await startAcrossRelease(s);
  start.healthy();
  // Its readiness read records the boot, as the cell's own observe does.
  const observed = await s.f.stub.fetch(
    new Request("http://runtime/observe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: s.f.target }),
    }),
  );
  assert.equal(observed.status, 200);
  await observed.body?.cancel();
  // A model call admitted at the endpoint, still streaming.
  const streaming = gate();
  s.f.hooks.model = async () => {
    streaming.reached();
    await streaming.opened;
    return undefined;
  };
  const call = s.f.stub.fetch(
    new Request("http://runtime/v1/responses", {
      method: "POST",
      headers: {
        "X-Signalbox-Runtime-Identity": JSON.stringify(s.f.identity()),
        "X-Signalbox-Runtime-Port": "8317",
      },
    }),
  );
  await Promise.race([
    streaming.arrived,
    call.then((response) => assert.fail(`answered ${response.status} before it streamed`)),
  ]);
  await neverAdopts(s, "streams");
  streaming.open();
  await (await call).text();
});

test("the root's endpoint never adopts: its object is the controller's, which the controller's own handover resets", async (context) => {
  for (const role of ["runtime", "legacy"] as const)
    await context.test(role, async (step) => {
      const { f, held, witness } = await startedEndpoint(step, role);
      const answer = await witness();
      if (role === "runtime") {
        // A fleet cell's own endpoint, the control: it adopts.
        assert.equal(answer.status, 200);
        assert.equal(((await answer.json()) as { kind: string }).kind, "adopting");
        assert.deepEqual(f.calls.resets, ["code adoption"]);
      } else {
        assert.equal(answer.status, 409);
        assert.equal(
          answer.headers.get("X-Signalbox-Runtime-Failure-Reason"),
          "slot_controller_code",
        );
        assert.deepEqual(held(), ["root"]);
        assert.deepEqual(f.calls.resets, [], "the root's object reset");
      }
    });
});

test("only a fleet first start adopts: a runtime's start of another kind refuses the controller's code and never resets", async (context) => {
  const { f, held, witness } = await startedEndpoint(context, "runtime", "start");
  const answer = await witness();
  assert.equal(answer.status, 409);
  assert.equal(answer.headers.get("X-Signalbox-Runtime-Failure-Reason"), "slot_controller_code");
  assert.deepEqual(held(), ["kind"]);
  assert.deepEqual(f.calls.resets, []);
});

test("an attestation signed by other controller code is refused as controller_code, and its endpoint adopts under the same guards and window", async (context) => {
  for (const role of ["runtime", "legacy"] as const)
    await context.test(role, async (step) => {
      const { f, attest } = await startedEndpoint(step, role);
      for (let index = 0; index < 2; index++) {
        const answer = await attest();
        assert.equal(answer.status, 409);
        assert.equal(
          answer.headers.get("X-Signalbox-Runtime-Failure-Reason"),
          "slot_controller_code",
        );
      }
      // The platform still serves the old code, so the second read meets a fresh instance on it.
      assert.deepEqual(f.calls.resets, role === "runtime" ? ["code adoption"] : []);
      assert.equal(
        (
          await new RuntimeWitnessStore(f.ctx.storage, f.env.POOL_DEPLOYMENT_KEY!).retained(
            f.target.slotId,
          )
        )?.attestation,
        undefined,
        "an attestation signed by other code was kept",
      );
    });
});

test("an endpoint resets at most once per window, and an instance still on the old code that finds its predecessor's record waits it out", async (context) => {
  const s = await stuckFleet(context, { demand: 1 });
  // The platform keeps serving the object the old code, so every reset comes back on it.
  const start = await startAcrossRelease(s, { deployed: false });
  start.healthy();
  await s.pass();
  assert.equal(s.f.calls.resets.length, 1, "the first read past the release didn't adopt");
  const first = Date.now();
  while (Date.now() - first < codeAdoptionWindowMs - 2_000) {
    const row = await s.pass();
    assert.notEqual(row?.phase, "ready");
    assert.equal(s.f.calls.resets.length, 1, "a second reset inside the window");
  }
  const lines = s.adoptions();
  assert.equal(lines[0]?.outcome, "resetting");
  assert.ok(lines.length > 2, "the fresh instance was never asked");
  // Each fresh instance found the record: it waited, and the adoption's start stayed put.
  for (const [index, line] of lines.slice(1).entries()) {
    assert.equal(line.outcome, "waiting");
    assert.equal(line.adoptingMs, (index + 1) * 2_000);
  }
});

test("an endpoint on older code, which never sees the controller's code, ends as before: held to its bound, quarantined and stopped, with no loop and no pass that throws", async (context) => {
  const s = await stuckFleet(context, { demand: 1 });
  const witnesses = () => s.f.transport.sent.filter((value) => value === "/witness").length;
  s.f.transport.older = "witness";
  const start = await startAcrossRelease(s);
  start.healthy();
  const refused = s.upkeepRefusals().length;
  let row;
  while ((row = await s.pass())?.phase !== "quarantined") {
    assert.notEqual(row?.phase, "ready");
    assert.ok(Date.now() - start.since <= startingBoundMs + 2_000, "held past its bound");
  }
  assert.equal(row?.reason, "start_unproven");
  assert.ok(row!.phaseAt! - start.since >= startingBoundMs, "quarantined before its bound");
  const reads = witnesses();
  assert.ok(reads <= startingBoundMs / 2_000 + 1, `${reads} witness reads: it looped`);
  // Each pass refused it for its code, as such, in the row's upkeep line and the growth line.
  const refusals = s.upkeepRefusals().slice(refused);
  assert.ok(refusals.length > 0);
  assert.deepEqual(new Set(refusals), new Set(["slot_controller_code"]));
  assert.deepEqual(
    s.warned("POOL_FLEET_GROWTH_STILL_REFUSED").map((line) => line.reason),
    ["controller_code"],
  );
  // The stop of a start that never activated, as before.
  await s.pass();
  assert.deepEqual(s.f.calls.signals, [15], "it was never stopped");
  assert.equal(await s.fenced(), true);
  assert.deepEqual(s.f.calls.resets, [], "an older endpoint reset");
});

/**
 * A slot started from a grant of `kind`, a fleet first start by default, on an endpoint of `role`
 * under the fixture's code; `witness` reads it as a controller on the released code does.
 */
async function startedEndpoint(
  context: TestContext,
  role: "legacy" | "runtime",
  kind: "initial-start" | "start" = "initial-start",
) {
  const info = context.mock.method(console, "info", () => {});
  const target = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "a".repeat(64),
    slotId: "adopting",
    applicationId: "runtime-app",
    applicationVersion: "3",
    instanceId: "b".repeat(64),
    imageDigest: `sha256:${"d".repeat(64)}`,
    imageInput: "2".repeat(16),
    ...(kind === "initial-start" ? { homePeerOrdinal: 1 } : {}),
  };
  const f = await handoffRuntime(
    target,
    {
      POOL_RUNTIME_APPLICATION_ID: target.applicationId,
      // The root's own endpoint is the one bound to the controller's container application.
      POOL_CONTAINER_APPLICATION_ID: role === "legacy" ? target.applicationId : "root-app",
      POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
      POOL_MANAGEMENT_KEY: "fixture-runtime-key",
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      POOL_IMAGE_HASH: target.imageInput,
      POOL_DEPLOYMENT_KEY: "e".repeat(64),
    },
    { role },
  );
  const controller = new RuntimeSqlite();
  context.after(async () => {
    await f.cleanup();
    await controller.close();
  });
  if (kind === "start") {
    // A candidate's start runs beside a selected root.
    const root = {
      ...target,
      slotId: "root",
      applicationId: "root-app",
      instanceId: target.controllerId,
      bootId: "root-boot",
    };
    await controller.put(slotSelectionKey, {
      epoch: 1,
      active: { target: root, identity: root, fenced: false },
    });
  }
  const grant = await runtimeGrant(f, controller, kind);
  await f.endpoint.admit(grant.envelope);
  await f.endpoint.start(target, AbortSignal.timeout(5_000));
  assert.equal(f.ctx.container.running, true);
  const proof = grant.proof;
  assert.ok(isLaunchAuthorization(proof));
  return {
    /** Its attestation, signed by a controller on the released code. */
    attest: async () =>
      f.stub.fetch(
        new Request("http://runtime/attest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            envelope: (
              await joinedRuntimeProof(f, controller, { ...proof, controllerCode: releasedCode })
            ).envelope,
          }),
        }),
      ),
    f,
    /** What held each adoption the endpoint refused, in order. */
    held: () =>
      info.mock.calls
        .filter((call) => call.arguments[0] === "POOL_RUNTIME_CODE_ADOPTION")
        .map((call) => (call.arguments[1] as { held?: string }).held),
    witness: () =>
      f.stub.fetch(
        new Request("http://runtime/witness", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target, controllerCode: releasedCode }),
        }),
      ),
  };
}
