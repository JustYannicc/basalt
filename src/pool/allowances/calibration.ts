import type { TokenCounts } from "../../../apps/pool/contract.ts";
import { allowanceEntry, dayMs, type PlanAllowance } from "./data.ts";

export interface CalibrationSample {
  readonly from: number;
  readonly to: number;
  readonly fraction: number;
  readonly tokens: number;
  readonly requests: number;
  readonly profile: string;
}
export interface AllowanceObservation {
  readonly account: string;
  readonly vendor: string;
  readonly plan: string;
  readonly windowSeconds: number;
  readonly mode: string | null;
  readonly at: number;
  readonly resetAt: number;
  readonly remaining: number;
}
export interface MeasuredConsumption {
  readonly account: string;
  readonly vendor: string;
  readonly at: number;
  readonly model: string;
  readonly tier: string;
  readonly tokens: TokenCounts;
}

/** Only a complete matching interval can turn quota movement into measured consumption. */
export function calibrationInterval(
  left: AllowanceObservation,
  right: AllowanceObservation,
  events: readonly MeasuredConsumption[],
): CalibrationSample | null {
  if (
    left.account !== right.account ||
    left.vendor !== right.vendor ||
    left.plan !== right.plan ||
    left.windowSeconds !== right.windowSeconds ||
    left.mode !== right.mode ||
    left.resetAt !== right.resetAt ||
    left.resetAt <= right.at ||
    right.at <= left.at ||
    right.at - left.at > 30 * 60_000 ||
    (right.mode !== "fixed" && right.windowSeconds === 18_000)
  )
    return null;
  const fraction = left.remaining - right.remaining;
  if (!Number.isFinite(fraction) || fraction < 0.02 || fraction > 1) return null;
  const matched = events.filter(
    (event) =>
      event.account === right.account &&
      event.vendor === right.vendor &&
      event.at >= left.at &&
      event.at < right.at,
  );
  if (
    matched.length < 3 ||
    matched.some(
      (event) =>
        !event.model ||
        event.model.length > 100 ||
        event.tier.length > 40 ||
        !Number.isSafeInteger(event.tokens.total) ||
        event.tokens.total <= 0,
    )
  )
    return null;
  const identities = new Set(matched.map((event) => JSON.stringify([event.model, event.tier])));
  if (identities.size !== 1) return null;
  const tokens = matched.reduce((sum, event) => sum + event.tokens.total, 0);
  const output = matched.reduce((sum, event) => sum + event.tokens.output, 0);
  const cached = matched.reduce((sum, event) => sum + event.tokens.cacheRead, 0);
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || output > tokens || cached > tokens)
    return null;
  return {
    from: left.at,
    to: right.at,
    fraction,
    tokens,
    requests: matched.length,
    profile: JSON.stringify([
      matched[0]!.model,
      matched[0]!.tier,
      Math.round((output / tokens) * 4),
      Math.round((cached / tokens) * 4),
    ]),
  };
}

/** An effective allowance for the observed workload, never a claimed vendor hard token cap. */
export function calibratedAllowance(input: {
  readonly vendor: string;
  readonly plan: string;
  readonly windowSeconds: number;
  readonly samples: readonly CalibrationSample[];
  readonly now: number;
  readonly previous?: PlanAllowance;
}): PlanAllowance | null {
  const samples = input.samples;
  if (
    samples.length < 3 ||
    samples.some(
      (sample, index) =>
        !Number.isFinite(sample.fraction) ||
        sample.fraction < 0.02 ||
        sample.fraction > 1 ||
        !Number.isSafeInteger(sample.tokens) ||
        sample.tokens <= 0 ||
        sample.requests < 3 ||
        sample.to <= sample.from ||
        sample.to > input.now ||
        input.now - sample.to >= dayMs ||
        sample.profile !== samples[0]!.profile ||
        (index > 0 && sample.from < samples[index - 1]!.to),
    )
  )
    return null;
  const fraction = samples.reduce((sum, sample) => sum + sample.fraction, 0);
  if (fraction < 0.1) return null;
  const full = samples.reduce((sum, sample) => sum + sample.tokens, 0) / fraction;
  if (
    !Number.isFinite(full) ||
    full <= 0 ||
    samples.some((sample) => Math.abs(sample.tokens / sample.fraction / full - 1) > 0.25)
  )
    return null;
  const unit = {
    id: JSON.stringify(["observed-tokens", input.vendor, samples[0]!.profile]),
    label: "observed tokens",
  };
  if (unit.id.length > 256) return null;
  const previous = input.previous;
  const stable =
    previous?.unit.id === unit.id &&
    previous.full !== null &&
    Math.abs(full / previous.full - 1) <= 0.25
      ? previous.full
      : Math.round(full);
  const checkedAt = samples.at(-1)!.to;
  return {
    ...allowanceEntry({
      vendor: input.vendor,
      plan: input.plan,
      windowSeconds: input.windowSeconds,
      full: stable,
      unit,
      kind: "account-calibration",
      verification: "estimated",
      checkedAt,
      fetchedAt: input.now,
      expiresAt: checkedAt + Math.min(dayMs, input.windowSeconds * 1000),
      sources: ["urn:basalt:account-quota-and-request-observations"],
      detail: `${samples.length} matched intervals; ${samples.reduce((sum, sample) => sum + sample.requests, 0)} requests. Estimated for this model and token mix; other clients can consume the same allowance.`,
    }),
    revision:
      previous?.unit.id === unit.id && previous.full === stable
        ? previous.revision
        : `calibration-v1:${stable}`,
  };
}
