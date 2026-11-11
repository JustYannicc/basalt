import {
  xaiCollectionPhases,
  xaiEligibilityFailureReasons,
  xaiProfileFields,
  type XaiProfileDiagnostic,
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

function profileDiagnostic(value: unknown): XaiProfileDiagnostic | undefined {
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
  const fields = {} as Record<
    (typeof xaiProfileFields)[number],
    { present: boolean; null: boolean; string: boolean }
  >;
  for (const path of xaiProfileFields) {
    const field = value.fields[path];
    if (!object(field)) return undefined;
    const { present, null: nil, string: text } = field;
    if (
      typeof present !== "boolean" ||
      typeof nil !== "boolean" ||
      typeof text !== "boolean" ||
      (!present && (nil || text)) ||
      (nil && text) ||
      (!json_valid && (present || nil || text))
    )
      return undefined;
    fields[path] = { present, null: nil, string: text };
  }
  const reason = xaiEligibilityFailureReasons.find((item) => item === value.failure_reason);
  if (value.failure_reason !== undefined && reason === undefined) return undefined;
  if (reason !== undefined) {
    if (!http_ok) return undefined;
    const camel = fields.subscriptionTier,
      snake = fields.subscription_tier;
    const tier = camel.present ? camel : snake;
    if (
      (reason === "malformed" && json_valid) ||
      (reason !== "malformed" && !json_valid) ||
      (reason === "missing" && (camel.present || snake.present)) ||
      (reason === "ambiguous" && !(camel.present && snake.present)) ||
      ((reason === "non-string" || reason === "unknown-tier") &&
        ((!camel.present && !snake.present) ||
          (camel.present && snake.present) ||
          tier.null ||
          tier.string !== (reason === "unknown-tier")))
    )
      return undefined;
  }
  return {
    responseReceived: response_received,
    httpOk: http_ok,
    jsonValid: json_valid,
    fields,
    ...(reason === undefined ? {} : { failureReason: reason }),
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
  const profile = raw.profile === undefined ? undefined : profileDiagnostic(raw.profile);
  if (raw.profile !== undefined && profile === undefined) return undefined;
  const monthly = response(raw.monthly, xaiMonthlyFields);
  const weekly = response(raw.weekly, xaiWeeklyFields);
  if (
    monthly === undefined ||
    weekly === undefined ||
    (!vendor_call_started &&
      (monthly.responseReceived || weekly.responseReceived || profile?.responseReceived))
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
      ...(profile === undefined ? {} : { profile }),
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
    ...(value.profile === undefined
      ? {}
      : {
          profile: {
            response_received: value.profile.responseReceived,
            http_ok: value.profile.httpOk,
            json_valid: value.profile.jsonValid,
            fields: value.profile.fields,
            ...(value.profile.failureReason === undefined
              ? {}
              : { failure_reason: value.profile.failureReason }),
          },
        }),
    monthly: sourceResponse(value.monthly),
    weekly: sourceResponse(value.weekly),
  };
}
