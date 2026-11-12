import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { RuntimeFleetPeers } from "./runtime-fleet/peers.ts";
import type { HomePeerEndpoint } from "./runtime-fleet/peers.ts";
import { peerTarget, type HomePeerSource } from "./runtime-slots/peer-access.ts";
import { SlotTarget, sameTarget, type SlotIdentity } from "./runtime-slots/contract.ts";

function fixture() {
  const legacy: SlotIdentity = {
    format: "pool-runtime-slot-v1",
    controllerId: "root",
    slotId: "legacy",
    applicationId: "legacy-app",
    applicationVersion: "1",
    instanceId: "root",
    imageDigest: `sha256:${"a".repeat(64)}`,
    imageInput: "legacy-image",
    bootId: "legacy-boot",
  };
  const runtime = Schema.decodeUnknownSync(SlotTarget)({
    ...legacy,
    slotId: "new",
    applicationId: "blue",
    instanceId: "blue-1",
    homePeerOrdinal: 1,
  });
  const legacySource: HomePeerSource = { kind: "legacy", identity: legacy };
  const runtimeSource: HomePeerSource = {
    kind: "runtime",
    witness: {
      target: runtime,
      operationId: "operation",
      manifestDigest: "b".repeat(64),
      configurationFingerprint: "c".repeat(64),
      launch: {
        operationId: "11111111-1111-1111-1111-111111111111",
        generation: 1,
        tokenHash: "d".repeat(64),
      },
    },
  };
  let phase = "warming",
    sourceValid = true;
  const calls: string[] = [];
  const endpoint = (target: typeof legacy): HomePeerEndpoint => ({
    assertHomePeer: async (source) => {
      calls.push(`assert:${target.slotId}`);
      assert.ok(sameTarget(target, peerTarget(source)));
      if (!sourceValid) throw new Error("actual launch changed");
    },
    homePeerSource: async () => (target.slotId === "legacy" ? legacySource : runtimeSource),
    openHomePeer: async (source) => {
      calls.push(`open:${peerTarget(source).slotId}`);
      return new Response("opaque");
    },
  });
  const router = new RuntimeFleetPeers({
    controllerId: "root",
    legacy: async () => legacy,
    rows: async () => [{ target: runtime, phase }],
    endpoint: (target) => endpoint({ ...target, bootId: "unused" }),
  });
  return {
    router,
    legacySource,
    runtimeSource,
    calls,
    phase: (value: string) => {
      phase = value;
    },
    invalid: () => {
      sourceValid = false;
    },
  };
}

test("a warming Home uses its actual-start authority to discover the owned legacy Home in both directions", async () => {
  const f = fixture();
  assert.equal(await (await f.router.open(f.runtimeSource, 0)).text(), "opaque");
  assert.equal(await (await f.router.open(f.legacySource, 1)).text(), "opaque");
  assert.deepEqual(f.calls, ["assert:new", "open:legacy", "assert:legacy", "open:new"]);
});

test("unknown, reserved and retiring peers cannot create or expose compute", async () => {
  const f = fixture();
  await assert.rejects(f.router.open(f.legacySource, 2), /identity/);
  for (const phase of ["reserved", "retiring", "retired"]) {
    f.phase(phase);
    await assert.rejects(f.router.open(f.legacySource, 1), /identity/);
    await assert.rejects(f.router.open(f.runtimeSource, 0), /identity/);
  }
  assert.ok(f.calls.every((call) => !call.startsWith("open:")));
});

test("a stale source or foreign controller is refused before any destination socket opens", async () => {
  const f = fixture();
  f.invalid();
  await assert.rejects(f.router.open(f.runtimeSource, 0), /actual launch changed/);
  const source = f.legacySource;
  if (source.kind !== "legacy") throw new Error("legacy source required");
  await assert.rejects(
    f.router.open({ ...source, identity: { ...source.identity, controllerId: "other" } }, 1),
    /identity/,
  );
  assert.ok(f.calls.every((call) => !call.startsWith("open:")));
});
