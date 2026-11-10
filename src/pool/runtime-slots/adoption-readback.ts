import { Schema } from "effect";
import { SelectionProof, UnattestedActive } from "./admission-proof.ts";
import { ControllerCode, SlotIdentity, sameControllerCode, sameIdentity } from "./contract.ts";

export const UnattestedAdoptionReadback = Schema.Struct({
  kind: UnattestedActive.fields.kind,
  controllerCode: ControllerCode,
  operationId: UnattestedActive.fields.operationId,
  manifestDigest: UnattestedActive.fields.manifestDigest,
  identity: SlotIdentity,
  configurationFingerprint: UnattestedActive.fields.configurationFingerprint,
  selection: SelectionProof,
});
export type UnattestedAdoptionReadback = typeof UnattestedAdoptionReadback.Type;
const response = Schema.decodeUnknownSync(Schema.Struct({ result: UnattestedAdoptionReadback }), {
  onExcessProperty: "error",
});
const authorization = Schema.decodeUnknownSync(UnattestedActive, { onExcessProperty: "error" });

/** Callers can name exact non-secret drift without forwarding a backend body. */
export class AdoptionReadbackMismatch extends Error {
  readonly property: string;
  readonly expected: unknown;
  readonly observed: unknown;
  constructor(property: string, expected: unknown, observed: unknown) {
    super(`Unattested adoption readback differs: ${property}`);
    this.property = property;
    this.expected = expected;
    this.observed = observed;
  }
}
function match(
  property: string,
  expected: unknown,
  observed: unknown,
  same = expected === observed,
) {
  if (!same) throw new AdoptionReadbackMismatch(property, expected, observed);
}

/** Consistency with a retained operation is not an enable grant or a replacement for its ACK. */
export function decodeUnattestedAdoptionResponse(value: unknown, expected: UnattestedActive) {
  expected = authorization(expected);
  const result = response(value).result;
  match("authorization.selection.expectedEpoch", 0, expected.selection.expectedEpoch);
  match("authorization.selection.active", null, expected.selection.active);
  match(
    "controllerCode",
    expected.controllerCode,
    result.controllerCode,
    sameControllerCode(expected.controllerCode, result.controllerCode),
  );
  match("operationId", expected.operationId, result.operationId);
  match("manifestDigest", expected.manifestDigest, result.manifestDigest);
  const identity = { ...expected.target, bootId: expected.bootId };
  match("identity", identity, result.identity, sameIdentity(identity, result.identity));
  match(
    "configurationFingerprint",
    expected.configurationFingerprint,
    result.configurationFingerprint,
  );
  match(
    "selection.expectedEpoch",
    expected.selection.expectedEpoch + 1,
    result.selection.expectedEpoch,
  );
  match(
    "selection.active",
    identity,
    result.selection.active,
    sameIdentity(result.selection.active ?? undefined, identity),
  );
  match("selection.policyDigest", expected.selection.policyDigest, result.selection.policyDigest);
  for (const [name, rows] of [
    ["authorization", expected.selection.revisions],
    ["readback", result.selection.revisions],
  ] as const) {
    const pools = rows.map((row) => row.pool),
      sorted = [...pools].sort((a, b) => a.localeCompare(b));
    match(
      `${name}.selection.revisions`,
      sorted,
      pools,
      new Set(pools).size === pools.length && pools.every((pool, index) => pool === sorted[index]),
    );
  }
  match(
    "selection.revisions",
    expected.selection.revisions,
    result.selection.revisions,
    expected.selection.revisions.length === result.selection.revisions.length &&
      expected.selection.revisions.every((row, index) => {
        const actual = result.selection.revisions[index]!;
        return (
          row.pool === actual.pool &&
          row.organization === actual.organization &&
          row.revision === actual.revision &&
          row.retired === actual.retired
        );
      }),
  );
  return result;
}
