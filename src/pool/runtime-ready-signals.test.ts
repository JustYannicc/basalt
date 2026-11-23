import assert from "node:assert/strict";
import { test } from "node:test";
import { readySignals, runtimeReadySignals, withReadySignals } from "./runtime-ready-signals.ts";
import { PoolRuntimeUnhealthy, type PoolStatus } from "./lifecycle.ts";
import {
  rememberRuntimeFailure,
  retainRuntimeFailure,
  stripRuntimeFailureHeaders,
} from "./runtime-route-diagnostic.ts";
import { runtimeErrorResponse } from "./runtime-slots/request-error.ts";
import { SlotRefused, type SlotIdentity } from "./runtime-slots/contract.ts";
import { failureRead } from "./runtime-fleet/failure-record.ts";
import { RuntimeHealthRefusalLog } from "./runtime-slots/health-refusal-log.ts";

const at = "2026-11-23T12:24:04.512Z";
/** A readiness answer as the container's supervisor writes it, beside its existing fields. */
const answer = {
  boot_id: "boot",
  started_at: "2026-11-23T12:00:00Z",
  refusal: "policy_unproven",
  last_lapse: { step: "plugin_probe", ms: 2_140, at },
  last_flip: { to: "refusing", reason: "policy_unproven", prior_ms: 61_000, at },
  lapses: 3,
  flips: 2,
};
const decoded = {
  lastLapse: { step: "plugin_probe", ms: 2_140, at },
  lastFlip: { to: "refusing", reason: "policy_unproven", priorMs: 61_000, at },
  lapses: 3,
  flips: 2,
};
const planted = "planted-container-text";

test("a readiness answer's signals decode into the Worker's closed shape", () => {
  assert.deepEqual(readySignals(answer), decoded);
  assert.deepEqual(
    readySignals({ last_flip: { to: "ready", reason: "restored", prior_ms: 0, at } }),
    { lastFlip: { to: "ready", reason: "restored", priorMs: 0, at } },
  );
});

test("an answer without signals, from an older image, carries none", () => {
  assert.equal(readySignals({ boot_id: "boot", started_at: "2026-11-23T12:00:00Z" }), undefined);
  assert.equal(readySignals({}), undefined);
  for (const body of [undefined, null, "text", 3, [answer]])
    assert.equal(readySignals(body), undefined);
});

test("a malformed value reads as null and keeps its siblings", () => {
  const lapse = (value: Record<string, unknown>) =>
    readySignals({ last_lapse: { step: "home_plugins", ms: 10, at, ...value } })?.lastLapse;
  for (const ms of ["10", -1, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER + 2, true, {}])
    assert.deepEqual(lapse({ ms }), { step: "home_plugins", ms: null, at }, String(ms));
  for (const value of [
    "2026-11-23 12:24:04.512Z",
    "2026-11-23T12:24:04Z",
    "2026-11-23T12:24:04.5Z",
    "2026-11-23T12:24:04.512+00:00",
    "2026-11-23T12:24:04.512",
    "2026-02-30T00:00:00.000Z",
    "2026-13-01T00:00:00.000Z",
    "2026-11-23T24:00:00.000Z",
    "+010000-01-01T00:00:00.000Z",
    1_763_900_644_512,
    { at },
  ])
    assert.deepEqual(lapse({ at: value }), { step: "home_plugins", ms: 10, at: null }, `${value}`);
  assert.deepEqual(lapse({ step: { step: "home_plugins" } }), { step: null, ms: 10, at });
  assert.deepEqual(readySignals({ last_lapse: { step: "home_plugins" } })?.lastLapse, {
    step: "home_plugins",
    ms: null,
    at: null,
  });
  assert.deepEqual(
    readySignals({
      last_lapse: "home_plugins",
      last_flip: [decoded.lastFlip],
      lapses: "3",
      flips: -2,
    }),
    { lastLapse: null, lastFlip: null, lapses: null, flips: null },
  );
  assert.deepEqual(readySignals({ ...answer, lapses: 0.5 }), { ...decoded, lapses: null });
});

test("an unknown step or flip reads as null and keeps its siblings", () => {
  assert.deepEqual(
    readySignals({ ...answer, last_lapse: { ...answer.last_lapse, step: "next" } }),
    {
      ...decoded,
      lastLapse: { ...decoded.lastLapse, step: null },
    },
  );
  assert.deepEqual(
    readySignals({ last_flip: { to: "half", reason: "unknown", prior_ms: 5, at } }),
    { lastFlip: { to: null, reason: null, priorMs: 5, at } },
  );
});

test("unknown keys are dropped, and no container text survives in any slot", () => {
  const value = readySignals({
    ...answer,
    [planted]: planted,
    note: planted,
    last_lapse: { step: planted, ms: planted, at: `${at} ${planted}`, [planted]: planted },
    last_flip: { to: planted, reason: planted, prior_ms: planted, at: planted, priorMs: 7 },
    lapses: planted,
    flips: { planted },
  });
  assert.deepEqual(value, {
    lastLapse: { step: null, ms: null, at: null },
    lastFlip: { to: null, reason: null, priorMs: null, at: null },
    lapses: null,
    flips: null,
  });
  assert.doesNotMatch(JSON.stringify(value), new RegExp(planted));
  assert.deepEqual(Object.keys(readySignals(answer) ?? {}), Object.keys(decoded));
});

test("a remote refusal carries the decoded signals across the binding into the fleet's read", () => {
  const local = withReadySignals(new PoolRuntimeUnhealthy(), readySignals(answer));
  rememberRuntimeFailure("endpoint_health", local);
  // The endpoint's own boundary writes the answer the controller's transport receives.
  const response = runtimeErrorResponse(local, "endpoint");
  const remote = retainRuntimeFailure(response, new SlotRefused("uncertain"));
  assert.deepEqual(runtimeReadySignals(remote), decoded);
  // A public answer drops it with the other failure headers.
  const headers = new Headers(response.headers);
  stripRuntimeFailureHeaders(headers);
  assert.deepEqual(
    [...headers.keys()].filter((name) => name.includes("runtime-failure")),
    [],
  );
  const read = failureRead(remote, "endpoint_health", 1_000, 12.4);
  assert.deepEqual(read, {
    at: 1_000,
    step: "endpoint_health",
    cause: "unhealthy",
    roundTripMs: 12,
    ready: decoded,
  });
  // A refusal without signals sends no header and records none.
  const plain = new PoolRuntimeUnhealthy();
  rememberRuntimeFailure("endpoint_health", plain);
  const unsignalled = retainRuntimeFailure(
    runtimeErrorResponse(plain, "endpoint"),
    new SlotRefused("uncertain"),
  );
  assert.equal(runtimeReadySignals(unsignalled), undefined);
  assert.equal("ready" in failureRead(unsignalled, "endpoint_health", 1_000), false);
});

test("a tampered signals header is decoded again: only closed values survive, or nothing", () => {
  const remote = (ready: string) => {
    const local = new PoolRuntimeUnhealthy();
    rememberRuntimeFailure("endpoint_health", local);
    const response = runtimeErrorResponse(local, "endpoint");
    response.headers.set("X-Signalbox-Runtime-Failure-Ready", ready);
    return retainRuntimeFailure(response, new SlotRefused("uncertain"));
  };
  const tampered = remote(
    JSON.stringify({
      lastLapse: { step: planted, ms: 4, at, note: planted },
      lastFlip: { to: "ready", reason: planted, priorMs: planted, at: planted },
      lapses: 2,
      flips: planted,
      [planted]: planted,
    }),
  );
  const ready = runtimeReadySignals(tampered);
  assert.deepEqual(ready, {
    lastLapse: { step: null, ms: 4, at },
    lastFlip: { to: "ready", reason: null, priorMs: null, at: null },
    lapses: 2,
    flips: null,
  });
  assert.doesNotMatch(
    JSON.stringify(failureRead(tampered, "endpoint_health", 1)),
    new RegExp(planted),
  );
  for (const header of [
    planted,
    JSON.stringify(planted),
    JSON.stringify({ [planted]: planted }),
    JSON.stringify({ lapses: 2, padding: planted.repeat(64) }),
  ])
    assert.equal(runtimeReadySignals(remote(header)), undefined, header.slice(0, 40));
});

const identity: SlotIdentity = {
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: "slot",
  applicationId: "application",
  applicationVersion: "1",
  instanceId: "instance",
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageInput: "input",
  bootId: "boot",
};
test("the health refusal line prints the signals the refusal or the answer carried, and only once a minute", (context) => {
  const lines: string[] = [];
  context.mock.method(console, "error", (name: string, fields: string) => {
    lines.push(`${name} ${fields}`);
  });
  let now = 0;
  context.mock.method(Date, "now", () => now);
  const printed = () => JSON.parse(lines.at(-1)!.replace("POOL_RUNTIME_HEALTH_REFUSED ", ""));
  const refusal = withReadySignals(new PoolRuntimeUnhealthy(), readySignals(answer));
  new RuntimeHealthRefusalLog().report(identity, refusal, true);
  assert.deepEqual(printed().ready, decoded);
  // A 200 the endpoint refused: the signals come from its status.
  const status: PoolStatus = { boot_id: "boot", started_at: "now", ready: readySignals(answer) };
  new RuntimeHealthRefusalLog().report(
    identity,
    new SlotRefused("unhealthy"),
    true,
    undefined,
    status,
  );
  assert.deepEqual(printed().ready, decoded);
  new RuntimeHealthRefusalLog().report(identity, new PoolRuntimeUnhealthy(), true);
  assert.equal("ready" in printed(), false);
  // A moving count is not a new refusal: the repeat waits its minute, then prints the latest.
  const log = new RuntimeHealthRefusalLog();
  log.report(identity, refusal, true);
  const count = lines.length;
  const later = withReadySignals(
    new PoolRuntimeUnhealthy(),
    readySignals({ ...answer, lapses: 4 }),
  );
  log.report(identity, later, true);
  assert.equal(lines.length, count);
  now = 60_000;
  log.report(identity, later, true);
  assert.equal(printed().ready.lapses, 4);
});
