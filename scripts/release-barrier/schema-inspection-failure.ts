import { StateStoreError } from "alchemy/State/State";
import { ReadOnlyStateStoreVersionMismatch } from "alchemy/State/ReadOnlyHttpStateStore";
import {
  SchemaInspectionRefusal,
  type SchemaInspectionReason,
} from "./schema-inspection-context.ts";
import { SqlSchemaAuthorityFailure } from "./sql-schema-sources.ts";

type InspectionFailure = {
  reason: SchemaInspectionReason;
  state?: { httpStatus?: number; expectedVersion?: number; observedVersion?: number };
  authority?: SqlSchemaAuthorityFailure["authority"];
};
const version = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

/** Only recognized typed failures contribute fields; private error messages never enter a receipt. */
export function schemaInspectionFailure(
  error: unknown,
  stage: SchemaInspectionReason,
): InspectionFailure {
  if (error instanceof ReadOnlyStateStoreVersionMismatch)
    return {
      reason: "schema-inspection-state-version",
      state: {
        ...(version(error.expected) ? { expectedVersion: error.expected } : {}),
        ...(version(error.observed) ? { observedVersion: error.observed } : {}),
      },
    };
  if (error instanceof StateStoreError) {
    const status = error.http?.status;
    return {
      reason: "schema-inspection-state-unavailable",
      ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
        ? { state: { httpStatus: status } }
        : {}),
    };
  }
  if (error instanceof SqlSchemaAuthorityFailure)
    return { reason: "schema-inspection-authority-unavailable", authority: error.authority };
  return { reason: error instanceof SchemaInspectionRefusal ? error.reason : stage };
}

export function schemaInspectionFailureMessage(failure: InspectionFailure) {
  const state = failure.state;
  const authority = failure.authority;
  return `Production schema inspection incomplete: ${failure.reason}.${state?.httpStatus === undefined ? "" : ` State HTTP=${state.httpStatus}.`}${state?.expectedVersion === undefined && state?.observedVersion === undefined ? "" : ` State version expected=${state?.expectedVersion ?? "unknown"} observed=${state?.observedVersion ?? "unknown"}.`}${authority ? ` ${authority.resource} status=${authority.status} check=${authority.check}.` : ""}`;
}
