import assert from "node:assert/strict";
import { test } from "node:test";
import { BarrierRefusal } from "./refusal.ts";
import { runtimeReleaseClientFixture as fixture } from "./test/runtime-release-client-fixture.ts";

// The policy lease is 1,500 ms; a CI runner's bridge setup alone takes longer than that.
const ciBridgeSetupMs = 2_000;

const refusedWith = (reason: string) => (error: unknown) =>
  error instanceof BarrierRefusal && error.reason === reason;

test(
  "bridge setup longer than the lease does not expire a live active-health lease",
  { timeout: 20_000 },
  async (context) => {
    const f = await fixture();
    context.after(() => f.cleanup());
    f.bridge.setupMs = ciBridgeSetupMs;
    const healthy = await f.client.health();
    assert.equal(
      healthy.instanceId,
      (await f.client.inspect()).selection!.active.identity.instanceId,
    );
  },
);

test(
  "a reply that arrives after its lease ran out still refuses",
  { timeout: 20_000 },
  async (context) => {
    const f = await fixture();
    context.after(() => f.cleanup());
    f.bridge.healthReplyMs = 1_600;
    await assert.rejects(f.client.health(), refusedWith("runtime-release-health-expired"));
  },
);

test(
  "a lease the controller reports as already spent refuses even over a fast bridge",
  { timeout: 20_000 },
  async (context) => {
    const f = await fixture();
    context.after(() => f.cleanup());
    f.bridge.healthReply = (reply) => ({ ...reply, leaseMs: 0 });
    await assert.rejects(f.client.health(), refusedWith("runtime-release-health-expired"));
  },
);

test(
  "a healthy reply for a runtime other than the selected one still refuses",
  { timeout: 20_000 },
  async (context) => {
    const f = await fixture();
    context.after(() => f.cleanup());
    f.bridge.setupMs = ciBridgeSetupMs;
    f.bridge.healthReply = (reply) => ({
      ...reply,
      identity: { ...(reply.identity as object), bootId: "other-boot" },
    });
    await assert.rejects(
      f.client.health(),
      (error: unknown) =>
        refusedWith("provisioning-input-drift")(error) &&
        (error as BarrierRefusal).delta?.changed[0]?.path === "runtime-release.healthy-selection",
    );
  },
);
