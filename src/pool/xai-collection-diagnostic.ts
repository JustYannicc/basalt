import {
  xaiCollectionPhases,
  xaiMonthlyFields,
  xaiWeeklyFields,
  type CollectionDiagnostic,
  type XaiCollectionDiagnostic,
  type XaiFieldPresence,
} from "../../apps/pool/collection-diagnostic-contract.ts";
import { object, type Json } from "./json.ts";

function response<Path extends string>(value: unknown, paths: readonly Path[]) {
  if (!object(value) || !object(value.fields)) return undefined;
  const { response_received, http_ok, json_valid } = value;
  if (
    typeof response_received !== "boolean" ||
    typeof http_ok !== "boolean" ||
    typeof json_valid !== "boolean" ||
    (http_ok && !response_received) ||
    (json_valid && !http_ok)
  )
    return undefined;
  const fields: Partial<Record<Path, XaiFieldPresence>> = {};
  for (const path of paths) {
    const field = value.fields[path];
    if (!object(field)) return undefined;
    const { present, null: nil, numeric } = field;
    if (
      typeof present !== "boolean" ||
      typeof nil !== "boolean" ||
      typeof numeric !== "boolean" ||
      (!present && (nil || numeric)) ||
      (nil && numeric) ||
      (!json_valid && (present || nil || numeric))
    )
      return undefined;
    fields[path] = { present, null: nil, numeric };
  }
  return {
    responseReceived: response_received,
    httpOk: http_ok,
    jsonValid: json_valid,
    fields: fields as Record<Path, XaiFieldPresence>,
  };
}

export function xaiCollectionDiagnostic(value: unknown): CollectionDiagnostic | undefined {
  if (!object(value) || value.provider !== "xai" || !object(value.xai)) return undefined;
  const at = typeof value.attempted_at === "string" ? Date.parse(value.attempted_at) : NaN;
  const raw = value.xai;
  const phase = xaiCollectionPhases.find((item) => item === raw.phase);
  const { vendor_call_started, probe_finished, snapshot_write_attempted, snapshot_persisted } = raw;
  if (
    !Number.isFinite(at) ||
    phase === undefined ||
    typeof vendor_call_started !== "boolean" ||
    typeof probe_finished !== "boolean" ||
    typeof snapshot_write_attempted !== "boolean" ||
    typeof snapshot_persisted !== "boolean" ||
    (snapshot_persisted && !snapshot_write_attempted)
  )
    return undefined;
  const monthly = response(raw.monthly, xaiMonthlyFields);
  const weekly = response(raw.weekly, xaiWeeklyFields);
  if (
    monthly === undefined ||
    weekly === undefined ||
    (!vendor_call_started && (monthly.responseReceived || weekly.responseReceived))
  )
    return undefined;
  if (phase === "claimed" || phase === "claim_failed" || phase === "claim_not_acquired") {
    if (vendor_call_started || probe_finished || snapshot_write_attempted) return undefined;
  } else if (
    !snapshot_write_attempted ||
    snapshot_persisted !== (phase === "snapshot_persisted" || phase === "failure_persisted")
  )
    return undefined;
  return {
    attemptedAt: new Date(at).toISOString(),
    provider: "xai",
    responseReceived: monthly.responseReceived || weekly.responseReceived,
    jsonValid: monthly.jsonValid && weekly.jsonValid,
    xai: {
      phase,
      vendorCallStarted: vendor_call_started,
      probeFinished: probe_finished,
      snapshotWriteAttempted: snapshot_write_attempted,
      snapshotPersisted: snapshot_persisted,
      monthly,
      weekly,
    },
  };
}

export function sourceXaiDiagnostic(value: XaiCollectionDiagnostic): Json {
  const sourceResponse = (
    response: XaiCollectionDiagnostic["monthly"] | XaiCollectionDiagnostic["weekly"],
  ) => ({
    response_received: response.responseReceived,
    http_ok: response.httpOk,
    json_valid: response.jsonValid,
    fields: response.fields,
  });
  return {
    phase: value.phase,
    vendor_call_started: value.vendorCallStarted,
    probe_finished: value.probeFinished,
    snapshot_write_attempted: value.snapshotWriteAttempted,
    snapshot_persisted: value.snapshotPersisted,
    monthly: sourceResponse(value.monthly),
    weekly: sourceResponse(value.weekly),
  };
}
