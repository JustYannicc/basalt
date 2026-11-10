import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
import { UnattestedActive } from "./runtime-slots/admission-proof.ts";
import {
  AdoptionReadbackMismatch,
  decodeUnattestedAdoptionResponse,
} from "./runtime-slots/adoption-readback.ts";

test("the strict shared adoption decoder binds each operation, boot, capsule and selection field", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const expected = Schema.decodeUnknownSync(UnattestedActive)(f.preservation.proof);
  const accepted = decodeUnattestedAdoptionResponse(f.adoptionAck, expected);
  const cases = [
    { property: "operationId", result: { ...accepted, operationId: "different-operation" } },
    { property: "manifestDigest", result: { ...accepted, manifestDigest: "f".repeat(64) } },
    {
      property: "controllerCode",
      result: {
        ...accepted,
        controllerCode: { ...accepted.controllerCode, candidate: "9".repeat(40) },
      },
    },
    {
      property: "identity",
      result: { ...accepted, identity: { ...accepted.identity, bootId: "different-boot" } },
    },
    {
      property: "identity",
      result: { ...accepted, identity: { ...accepted.identity, instanceId: "different-instance" } },
    },
    {
      property: "configurationFingerprint",
      result: { ...accepted, configurationFingerprint: "f".repeat(64) },
    },
    {
      property: "selection.expectedEpoch",
      result: { ...accepted, selection: { ...accepted.selection, expectedEpoch: 2 } },
    },
    {
      property: "selection.active",
      result: { ...accepted, selection: { ...accepted.selection, active: null } },
    },
    {
      property: "selection.policyDigest",
      result: { ...accepted, selection: { ...accepted.selection, policyDigest: "f".repeat(64) } },
    },
    {
      property: "selection.revisions",
      result: {
        ...accepted,
        selection: {
          ...accepted.selection,
          revisions: accepted.selection.revisions.map((row, index) =>
            index ? row : { ...row, retired: !row.retired },
          ),
        },
      },
    },
  ];
  for (const item of cases)
    assert.throws(
      () => decodeUnattestedAdoptionResponse({ result: item.result }, expected),
      (error) => error instanceof AdoptionReadbackMismatch && error.property === item.property,
    );
  for (const body of [
    { result: { ...accepted, extra: "unaccepted" } },
    { result: accepted, extra: "unaccepted" },
    {
      result: { ...accepted, controllerCode: { ...accepted.controllerCode, extra: "unaccepted" } },
    },
    { result: { kind: "witness", controllerCode: accepted.controllerCode, witness: {} } },
    { result: null },
  ])
    assert.throws(() => decodeUnattestedAdoptionResponse(body, expected));
});

test("even mutually matching noncanonical or duplicate policy revisions cannot pass the adoption decoder", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const expected = Schema.decodeUnknownSync(UnattestedActive)(f.preservation.proof);
  const accepted = decodeUnattestedAdoptionResponse(f.adoptionAck, expected);
  for (const revisions of [
    [...expected.selection.revisions].reverse(),
    [...expected.selection.revisions, expected.selection.revisions[0]!],
  ]) {
    assert.throws(
      () =>
        decodeUnattestedAdoptionResponse(
          { result: { ...accepted, selection: { ...accepted.selection, revisions } } },
          { ...expected, selection: { ...expected.selection, revisions } },
        ),
      /authorization.selection.revisions/,
    );
  }
});
