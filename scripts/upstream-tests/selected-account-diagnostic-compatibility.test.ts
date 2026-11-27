import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { AccountHealth } from "../../.upstream/packages/apps/src/contracts/account-health.ts";
import { AccountObservationView } from "../../.upstream/packages/apps/src/contracts/account-observation-view.ts";
import {
  encodeSelectedAccountHealth,
  selectedAccountObservations,
} from "../../.upstream/packages/apps/src/contracts/selected-account-health.ts";
import { current as protocol41 } from "../../.upstream/packages/apps/src/contracts/protocols/41.ts";
import { current as protocol42 } from "../../.upstream/packages/apps/src/contracts/protocols/current.ts";

test("retained selected-account readers accept provenance refusals without changing native diagnostics", async () => {
  const failure = { tag: "FrameworkProvenanceRefused", phase: "invoke" };
  const check = {
    status: "check_failed",
    checkedAt: new Date("2026-01-01T00:00:00Z"),
    current: true,
    failure,
  };
  const native = await Effect.runPromise(
    Schema.decodeUnknownEffect(AccountHealth)({
      account: "acc_fixture",
      info: null,
      infoCheckedAt: null,
      apps: [{ app: "app_fixture", checkable: true, check }],
      driver: {
        source: { kind: "driver", id: "fixture", version: "1" },
        checkable: true,
        check,
      },
    }),
  );
  const observations = await Effect.runPromise(
    Schema.decodeUnknownEffect(AccountObservationView)({
      account: native.account,
      reports: [
        {
          source: { kind: "app", id: "app_fixture", label: "Fixture", version: "1" },
          credentialGeneration: 1,
          result: null,
          checkedAt: null,
          lastAttempt: { attemptedAt: "2026-01-01T00:00:00Z", outcome: "unavailable", failure },
          freshness: "unavailable",
          collecting: false,
          nextAllowedAt: null,
        },
      ],
    }),
  );
  const health = await Effect.runPromise(encodeSelectedAccountHealth(native));
  const retainedObservations = selectedAccountObservations(observations);
  const reply = {
    ok: true,
    value: {
      state: "available",
      account: { id: native.account, label: "Fixture", method: "apiKey" },
      sourceApp: { id: "app_fixture", version: "1", name: "Fixture" },
      health,
      canInspect: true,
      observations: retainedObservations,
    },
  };
  for (const protocol of [protocol41, protocol42]) {
    await Effect.runPromise(
      Schema.decodeUnknownEffect(protocol.schemas.selectedAccountReadReply)(reply),
    );
  }
  assert.equal(health.apps[0]?.check?.failure?.tag, "RuntimeBuildUnavailable");
  assert.equal(health.driver?.check?.failure?.tag, "RuntimeBuildUnavailable");
  assert.equal(
    retainedObservations?.reports[0]?.lastAttempt?.failure?.tag,
    "RuntimeBuildUnavailable",
  );
  assert.equal(native.apps[0]?.check?.failure?.tag, "FrameworkProvenanceRefused");
  assert.equal(native.driver?.check?.failure?.tag, "FrameworkProvenanceRefused");
  assert.equal(observations.reports[0]?.lastAttempt?.failure?.tag, "FrameworkProvenanceRefused");
  assert.equal(selectedAccountObservations(null), null);
});
