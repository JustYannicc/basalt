import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { PoolDependencyFailure } from "./dependency-failure.ts";
import { FleetRefused } from "./runtime-fleet/state.ts";
import { ProviderObservationRefused } from "./runtime-provider/read.ts";
import { ProtectionRefusal } from "./runtime-protection.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { signEnvelope } from "./token.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { runtimeHandoffCommandPrefix } from "./runtime-slots/handoff-command.ts";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";

test("an endpoint defect stays a correlated 500 through the handoff without repeating admission", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  const logs: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => logs.push(values));
  const admission = context.mock.method(f.candidate.endpoint, "admit", async () => {
    throw new TypeError("secret-input-that-must-not-escape");
  });
  const response = await f.command("stage", { proof: grant.envelope });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "runtime-defect");
  assert.match(body.requestId, /^[a-f0-9-]{36}$/u);
  assert.equal(response.headers.get("X-Request-Id"), body.requestId);
  const defects = logs
    .flat()
    .filter((value) => typeof value === "string" && value.includes("POOL_RUNTIME_REQUEST_DEFECT"));
  assert.equal(defects.length, 1);
  assert.match(String(defects[0]), /TypeError/u);
  assert.ok(String(defects[0]).includes(body.requestId));
  assert.ok(
    !JSON.stringify([body, logs, [...response.headers]]).includes(
      "secret-input-that-must-not-escape",
    ),
  );
  assert.equal(admission.mock.callCount(), 1);
  assert.equal(f.candidate.calls.start, 0);
});

test("malformed commands, admission proofs and identity headers are typed identity refusals", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const logs: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => logs.push(values));
  const now = Date.now();
  const signed = async (fields: object) =>
    JSON.stringify({
      envelope: await signEnvelope(f.old.env.POOL_DEPLOYMENT_KEY!, runtimeHandoffCommandPrefix, {
        action: "inspect",
        controllerCode: runtimeFixtureCode,
        at: now,
        expiresAt: now + 60_000,
        ...fields,
      }),
    });
  const invalidCommands = [
    "{",
    "{}",
    JSON.stringify({ envelope: "bad-signature" }),
    await signed({ expiresAt: now - 1 }),
    await signed({ action: "invalid" }),
    await signed({ controllerCode: { ...runtimeFixtureCode, candidate: "f".repeat(40) } }),
    await signed({ action: "stage", proof: "bad-proof" }),
  ];
  for (const body of invalidCommands) {
    const response = await f.worker.runtimeHandoff(
      new Request("http://operations/runtime-handoff", { method: "POST", body }),
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, "runtime_endpoint_route_slot_identity");
  }
  for (const request of [
    new Request("http://runtime/v1/models", { headers: { "X-Signalbox-Runtime-Identity": "" } }),
    new Request("http://runtime/admit", { method: "POST", body: "{" }),
    new Request("http://runtime/admit", { method: "POST", body: "{}" }),
    new Request("http://runtime/admit", {
      method: "POST",
      body: JSON.stringify({ envelope: "bad-proof" }),
    }),
    new Request("http://runtime/v1/models", {
      headers: { "X-Signalbox-Runtime-Identity": "invalid" },
    }),
    new Request("http://runtime/v1/models", {
      headers: { "X-Signalbox-Runtime-Identity": "{}", "X-Signalbox-Runtime-Port": "8317" },
    }),
  ]) {
    const response = await f.candidate.stub.fetch(request);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, "runtime_endpoint_route_slot_identity");
  }
  assert.equal(logs.length, 0);
  assert.equal(f.candidate.calls.start, 0);
});

test("the handoff boundary distinguishes a typed refusal from a storage defect", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const logs: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => logs.push(values));
  let defect = false;
  context.mock.method(f.old.storage, "transaction", async () => {
    if (defect) throw new RangeError("storage-secret");
    throw new SlotRefused("selection");
  });
  const refused = await f.command("inspect");
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).reason, "runtime_endpoint_route_slot_selection");
  assert.equal(logs.length, 0);
  defect = true;
  const response = await f.command("inspect");
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, "runtime-defect");
  assert.equal(response.headers.get("X-Request-Id"), body.requestId);
  assert.equal(logs.length, 1);
  assert.ok(JSON.stringify(logs).includes(body.requestId));
  assert.ok(JSON.stringify(logs).includes("RangeError"));
  assert.ok(!JSON.stringify([body, logs]).includes("storage-secret"));
});

test("schema errors inside endpoint service work remain defects and signed headerless admission works", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  const admitted = await f.candidate.stub.fetch(
    new Request("http://runtime/admit", {
      method: "POST",
      body: JSON.stringify({ envelope: grant.envelope }),
    }),
  );
  assert.equal(admitted.status, 204);
  const logs: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => logs.push(values));
  context.mock.method(f.candidate.endpoint, "admit", async () => {
    Schema.decodeUnknownSync(Schema.String)(42);
  });
  const response = await f.candidate.stub.fetch(
    new Request("http://runtime/admit", {
      method: "POST",
      body: JSON.stringify({ envelope: grant.envelope }),
    }),
  );
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "runtime-defect");
  assert.equal(logs.length, 1);
});

test("recognized refusal classes keep closed reasons and defects never echo arbitrary error fields", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const logs: unknown[][] = [];
  context.mock.method(console, "error", (...values: unknown[]) => logs.push(values));
  let failure: unknown;
  context.mock.method(f.old.storage, "transaction", async () => {
    throw failure;
  });
  for (const [error, reason] of [
    [
      new PoolDependencyFailure("membership", new Error("private-dependency")),
      "runtime_endpoint_route_transport",
    ],
    [new FleetRefused("capacity"), "runtime_endpoint_route_fleet_capacity"],
    [new ProtectionRefusal("boot_changed"), "runtime_endpoint_route_protection_boot_changed"],
    [new ProviderObservationRefused("provider_fetch_failed"), "provider_fetch_failed"],
  ] as const) {
    failure = error;
    const response = await f.command("inspect");
    assert.equal(response.status, 409);
    assert.equal((await response.json()).reason, reason);
  }
  assert.equal(logs.length, 0);
  failure = {
    name: "private-name",
    get message() {
      throw new Error("private-getter");
    },
  };
  const response = await f.command("inspect");
  assert.equal(response.status, 500);
  assert.ok(logs.flat().join(" ").includes('"causeClass":"other"'));
  assert.ok(!JSON.stringify(logs).includes("private-"));
});
