import assert from "node:assert/strict";
import { test } from "node:test";
import { runPoolFleet } from "./dispatch.ts";
import { shortHash } from "./controller.ts";
import { harness } from "./test/harness.ts";

const inspect = {
  mode: "inspect",
  go: "",
  ref: "refs/heads/main",
  event: "workflow_dispatch",
};

test("the inspect lane shows the root's last recovery as closed values, keyed by the restarted boot", async () => {
  const lane = await harness({
    lastRecovery: {
      boot: "primary-boot-before",
      detectedAt: Date.UTC(2026, 10, 24, 3, 14, 17),
      readyAt: Date.UTC(2026, 10, 24, 3, 19, 40),
      rounds: 4,
      refusals: [
        {
          round: 1,
          at: Date.UTC(2026, 10, 24, 3, 14, 18),
          reason: "slot_identity",
          step: "endpoint_route",
          class: "SlotRefused",
        },
        {
          round: 2,
          at: Date.UTC(2026, 10, 24, 3, 16, 0),
          reason: "free text a newer Worker wrote",
          class: "Error",
          provider: "provider_fetch_failed",
        },
        {
          round: 3,
          at: Date.UTC(2026, 10, 24, 3, 17, 0),
          reason: "read_status",
          class: "ProviderObservationRefused",
          provider: "provider_observation_refused",
          read: "recovery",
          status: 429,
        },
        {
          round: 4,
          at: Date.UTC(2026, 10, 24, 3, 18, 0),
          reason: "sibling_unsettled",
          class: "ProviderObservationRefused",
          provider: "provider_observation_refused",
          read: "attested",
          state: "a state a newer Worker wrote",
        },
      ],
    },
  });
  try {
    const result = await runPoolFleet(inspect, lane.deps());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual((result as { result: { lastRecovery: unknown } }).result.lastRecovery, {
      key: shortHash("primary-boot-before"),
      detectedAt: "2026-11-24T03:14:17.000Z",
      readyAt: "2026-11-24T03:19:40.000Z",
      rounds: 4,
      refusals: [
        {
          round: 1,
          at: "2026-11-24T03:14:18.000Z",
          reason: "slot_identity",
          step: "endpoint_route",
          class: "SlotRefused",
          provider: null,
          read: null,
          status: null,
          field: null,
          state: null,
        },
        {
          round: 2,
          at: "2026-11-24T03:16:00.000Z",
          reason: "other",
          step: null,
          class: "Error",
          provider: "provider_fetch_failed",
          read: null,
          status: null,
          field: null,
          state: null,
        },
        // A provider refusal keeps its read and the status or state behind it, closed again here.
        {
          round: 3,
          at: "2026-11-24T03:17:00.000Z",
          reason: "read_status",
          step: null,
          class: "ProviderObservationRefused",
          provider: "provider_observation_refused",
          read: "recovery",
          status: 429,
          field: null,
          state: null,
        },
        {
          round: 4,
          at: "2026-11-24T03:18:00.000Z",
          reason: "sibling_unsettled",
          step: null,
          class: "ProviderObservationRefused",
          provider: "provider_observation_refused",
          read: "attested",
          status: null,
          field: null,
          state: "other",
        },
      ],
    });
  } finally {
    await lane.close();
  }
});

test("a controller with no recovery record, or one this lane can't read, shows none and still inspects", async () => {
  for (const lastRecovery of [null, { boot: 7, rounds: "two" }]) {
    const lane = await harness({ lastRecovery });
    try {
      const result = await runPoolFleet(inspect, lane.deps());
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal((result as { result: { lastRecovery: unknown } }).result.lastRecovery, null);
    } finally {
      await lane.close();
    }
  }
});
