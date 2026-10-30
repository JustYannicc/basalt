import { object, text, type Json } from "./json.ts";

const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const records = (value: unknown): Json[] => Array.isArray(value) ? value.filter(object) : [];

/** Internal Home data. Raw window/period fields never enter an account API response. */
export interface QuotaWindowObservation {
  readonly id: string | null;
  readonly label: string | null;
  readonly scope: string | null;
  readonly scopeId: string | null;
  readonly mode: string | null;
  readonly unit: string | null;
  readonly currency: string | null;
  readonly used: number | null;
  readonly remaining: number | null;
  readonly limit: number | null;
  readonly usedRatio: number | null;
  readonly remainingRatio: number | null;
  readonly unlimited: boolean | null;
  readonly resetAt: string | null;
  readonly observedAt: string | null;
  readonly staleAt: string | null;
  readonly source: string | null;
  readonly period: {
    readonly seconds: number | null;
    readonly unit: string | null;
    readonly value: number | null;
    readonly mode: string | null;
    readonly raw: unknown;
  };
  readonly raw: Readonly<Json>;
}

export interface QuotaObservation {
  readonly plan: { readonly name: string | null; readonly premium: boolean | null; readonly rawTier: null; readonly raw: Readonly<Json> } | null;
  readonly observedAt: string | null;
  readonly staleAt: string | null;
  readonly source: string | null;
  readonly collection: {
    readonly status: string | null;
    readonly freshness: string | null;
    readonly attemptedAt: string | null;
    readonly nextAllowedAt: string | null;
    readonly errorCode: string | null;
  };
  readonly windows: readonly QuotaWindowObservation[];
  readonly resets: {
    readonly available: number | null;
    readonly observedAt: string | null;
    readonly credits: readonly { readonly id: string | null; readonly status: string | null; readonly expiresAt: string | null }[];
  } | null;
}

/** Keep every reported window, including model scopes and unfamiliar durations. No plan invents a window. */
export function quotaObservation(detail: Json): QuotaObservation {
  const credential = object(detail.credential) ? detail.credential : detail;
  const collection = object(detail.collection) ? detail.collection : credential;
  const plan = object(credential.plan) ? credential.plan : null;
  const reset = object(detail.reset_credits) ? detail.reset_credits : null;
  const error = object(collection.error) ? collection.error : null;
  const windows = Array.isArray(detail.windows) ? records(detail.windows) : records(credential.primary_windows);
  return {
    plan: plan === null ? null : { name: text(plan.name), premium: bool(plan.premium), rawTier: null, raw: structuredClone(plan) },
    observedAt: text(collection.observed_at ?? credential.observed_at),
    staleAt: text(collection.expires_at ?? credential.expires_at),
    source: text(collection.source ?? credential.source),
    collection: {
      status: text(collection.status ?? credential.collection_status),
      freshness: text(collection.freshness ?? credential.freshness),
      attemptedAt: text(collection.last_attempt_at ?? credential.last_attempt_at),
      nextAllowedAt: text(collection.next_probe_at ?? credential.next_probe_at),
      errorCode: text(error?.code),
    },
    windows: windows.map((window) => {
      const period = object(window.period) ? window.period : null;
      return {
        id: text(window.id), label: text(window.label), scope: text(window.scope), scopeId: text(window.scope_id),
        mode: text(window.mode), unit: text(window.unit), currency: text(window.currency),
        used: number(window.used), remaining: number(window.remaining), limit: number(window.limit),
        usedRatio: number(window.used_ratio), remainingRatio: number(window.remaining_ratio),
        unlimited: bool(window.is_unlimited), resetAt: text(window.reset_at), observedAt: text(window.observed_at),
        staleAt: text(window.expires_at), source: text(window.source),
        period: {
          seconds: number(window.window_seconds), unit: text(window.period_unit), value: number(window.period_value),
          mode: text(period?.mode ?? window.mode), raw: structuredClone(window.period ?? null),
        },
        raw: structuredClone(window),
      };
    }),
    resets: reset === null ? null : {
      available: number(reset.available_count), observedAt: text(reset.observed_at),
      credits: records(reset.credits).map((credit) => ({ id: text(credit.id), status: text(credit.status), expiresAt: text(credit.expires_at) })),
    },
  };
}
