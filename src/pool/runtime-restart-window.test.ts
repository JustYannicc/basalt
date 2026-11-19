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

test("admission serves a boot only while its pool's current policy is installed", async () => {
  // This is what makes the restart window safe: recovery commits a restarted boot after installing
  // every current policy on it, and a newer revision stays dirty, refusing admission, until installed.
  const installed = await routerWith(false, 7);
  const response = await installed.router.forward(
    "pool",
    new Request("http://pool/v1/responses", { method: "POST", body: "{}" }),
    8327,
    async (signal) =>
      new Request("http://pool/v1/responses", { method: "POST", body: "{}", signal }),
  );
  assert.equal(await response.text(), "served");
  assert.equal(installed.sent.length, 1);

  const pending = await routerWith(true, 8);
  await assert.rejects(
    pending.router.forward(
      "pool",
      new Request("http://pool/v1/responses", { method: "POST", body: "{}" }),
      8327,
      async (signal) =>
        new Request("http://pool/v1/responses", { method: "POST", body: "{}", signal }),
    ),
    (error) => runtimeRouteDiagnostic(error)?.runtimeReason === "slot_policy",
  );
  assert.equal(pending.sent.length, 0, "never sent to a boot without the current revision");
});
