import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { RuntimeSlotRouter } from "./runtime-slots/router.ts";
import {
  RuntimeSlotStorage,
  nativeMembershipKey,
  slotSelectionKey,
} from "./runtime-slots/storage.ts";
import { SlotStreams } from "./runtime-slots/streams.ts";
import { runtimeRouteDiagnostic } from "./runtime-route-diagnostic.ts";
import type { SlotDriver, SlotIdentity } from "./runtime-slots/contract.ts";

const boot = (bootId: string): SlotIdentity => ({
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: "legacy",
  applicationId: "app",
  applicationVersion: "1",
  instanceId: "instance",
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageInput: "image",
  bootId,
});

async function routerWith(dirty: boolean, revision: number) {
  const identity = boot("boot-restarted");
  const memory = new SlotMemory();
  await memory.put(slotSelectionKey, {
    epoch: 5,
    active: { target: identity, identity, fenced: false },
  });
  await memory.put(nativeMembershipKey, {
    pool: {
      pool: "pool",
      organization: "organization",
      revision,
      expiresAt: Date.now() + 60_000,
      accounts: ["account"],
      dirty,
      native: true,
    },
  });
  const sent: Request[] = [];
  const driver = {
    health: async () => ({ identity, policyLeaseUntil: performance.now() + 1_500 }),
    fetch: async (_identity: SlotIdentity, request: Request) => {
      sent.push(request);
      return new Response("served");
    },
  } as unknown as SlotDriver;
  const router = new RuntimeSlotRouter({
    controllerId: "controller",
    driver,
    storage: new RuntimeSlotStorage(memory),
    streams: new SlotStreams(),
    clock: { now: Date.now, monotonic: () => performance.now() },
    defer: () => {},
    // The body is read in the test; releasing here ends the protection watcher with the stream.
    wrap: (response, lease) => {
      lease.release();
      return response;
    },
  });
  return { router, sent };
}

test("admission refuses a pool whose policy is dirty and serves one whose policy is clean", async () => {
  // Part of what makes the restart window safe: recovery commits a restarted boot after installing
  // every current policy on it, and a dirty policy refuses admission. A newer clean revision is
  // saved before it is installed; until then the boot's plugin refuses its revision assertion.
  const clean = await routerWith(false, 7);
  const response = await clean.router.forward(
    "pool",
    new Request("http://pool/v1/responses", { method: "POST", body: "{}" }),
    8327,
    async (signal) =>
      new Request("http://pool/v1/responses", { method: "POST", body: "{}", signal }),
  );
  assert.equal(await response.text(), "served");
  assert.equal(clean.sent.length, 1);

  const dirty = await routerWith(true, 8);
  await assert.rejects(
    dirty.router.forward(
      "pool",
      new Request("http://pool/v1/responses", { method: "POST", body: "{}" }),
      8327,
      async (signal) =>
        new Request("http://pool/v1/responses", { method: "POST", body: "{}", signal }),
    ),
    (error) => runtimeRouteDiagnostic(error)?.runtimeReason === "slot_policy",
  );
  assert.equal(dirty.sent.length, 0, "a dirty policy is never sent");
});
