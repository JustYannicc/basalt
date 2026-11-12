import type { PoolOverviewResult } from "../overview-contract.ts";
import type { PoolReliabilitySlo, ReliabilityCounts } from "../reliability-contract.ts";
import type { Tone } from "./capacity-view.tsx";

export type Reliability = NonNullable<PoolOverviewResult["reliability"]>;

// Integer tenths keep float error out of the threshold: success rounds down so 99.96% never reads
// as 100% and 98.96% never as 99%; failure rounds up so one failure never reads as 0%.
export const successText = ({ requests, failed }: ReliabilityCounts) =>
  `${(Number((BigInt(requests - failed) * 1000n) / BigInt(requests)) / 10).toFixed(failed ? 1 : 0)}%`;

export const failedShareText = ({ requests, failed }: ReliabilityCounts) =>
  `${(Number((BigInt(failed) * 1000n + BigInt(requests) - 1n) / BigInt(requests)) / 10).toFixed(1)}%`;

const reasons: Record<NonNullable<PoolReliabilitySlo["reason"]>, string> = {
  history_inactive: "request history isn't being captured",
  capture_stale: "the last capture is over 10 minutes old",
  capture_lagging: "request capture hasn't caught up yet",
  classification_pending: "proof checks aren't separated yet",
};

const windowText = (label: string, real: ReliabilityCounts) =>
  `${label} ${real.requests ? successText(real) : "no real requests"}`;

/** One line for the 1h and 24h windows against the target, or why there is no verdict. */
export function sloText(slo: PoolReliabilitySlo) {
  if (slo.state === "unavailable")
    return `Success vs ${slo.target}% target unavailable: ${slo.reason ? reasons[slo.reason] : "no current reading"}`;
  if (slo.state === "no_traffic") return `1h and 24h: no real requests · target ${slo.target}%`;
  return `${windowText("1h", slo.hour.real)} · ${windowText("24h", slo.day.real)} · target ${slo.target}%`;
}

export interface Broken {
  readonly tone?: Tone;
  readonly answer: string;
  readonly sub: readonly string[];
}

/**
 * The "Anything broken?" answer from real traffic. Proof checks never count; without a
 * classification the share is named as mixed rather than passed off as real.
 */
export function brokenAnswer({
  needYou,
  reliability,
  viewRead,
}: {
  needYou: number;
  reliability: Reliability;
  viewRead: boolean;
}): Broken {
  const { range, slo } = reliability;
  const real = range.real;
  const pending = range.classification === "pending";
  const failed = real.requests
    ? `${failedShareText(real)} of ${pending ? "" : "real "}requests failed`
    : null;
  const sub = [
    needYou && real.failed ? failed : null,
    pending ? "Includes proof checks; not separated yet" : null,
    sloText(slo),
  ].filter((line): line is string => line !== null);
  if (needYou)
    return {
      tone: "bad",
      answer: `${needYou} ${needYou === 1 ? "account needs" : "accounts need"} you`,
      sub,
    };
  if (slo.state === "breached") return { tone: "bad", answer: `Below ${slo.target}% success`, sub };
  if (!real.requests) return { answer: pending ? "No requests yet" : "No real requests", sub };
  if (real.failed) return { tone: "warn", answer: failed!, sub };
  if (slo.state === "unavailable") return { tone: "warn", answer: "Success rate unavailable", sub };
  return { tone: viewRead ? "ok" : undefined, answer: "Nothing broken", sub };
}

export interface FailureItem {
  readonly tone: Tone;
  readonly text: string;
  readonly sub: string;
}

/** Needs-attention lines: real failures first, proof checks counted apart and never mixed in. */
export function failureItems(reliability: Reliability, days: number): FailureItem[] {
  const { range, slo } = reliability;
  const { real, proof } = range;
  const items: FailureItem[] = [];
  if (slo.state === "unavailable")
    items.push({ tone: "warn", text: "Request success rate unavailable", sub: sloText(slo) });
  if (slo.state === "breached")
    items.push({
      tone: "bad",
      text: `Real-request success is below the ${slo.target}% target`,
      sub: `${sloText(slo)}.`,
    });
  const proofNote = proof.requests
    ? `Proof checks counted apart: ${proof.failed.toLocaleString()} of ${proof.requests.toLocaleString()} failed.`
    : "";
  if (real.failed)
    items.push({
      tone: "warn",
      text:
        range.classification === "pending"
          ? `${real.failed.toLocaleString()} of ${real.requests.toLocaleString()} requests failed in ${days} days`
          : `${real.failed.toLocaleString()} of ${real.requests.toLocaleString()} real requests failed in ${days} days`,
      sub: [
        real.unassignedFailures
          ? `${real.unassignedFailures.toLocaleString()} failed before reaching any account.`
          : "Which accounts they hit is on the Accounts tab.",
        range.classification === "pending"
          ? "Includes proof checks; they aren't separated yet."
          : proofNote,
      ]
        .filter(Boolean)
        .join(" "),
    });
  else if (proof.failed)
    items.push({
      tone: "info",
      text: `${proof.failed.toLocaleString()} of ${proof.requests.toLocaleString()} proof checks failed in ${days} days`,
      sub: "Proof checks only, counted apart. No real request failed.",
    });
  return items;
}

/** Older servers report one total that includes proof checks; it is never labeled real. */
export function legacyBrokenAnswer({
  needYou,
  sum,
  read,
  usage,
  viewRead,
  worstHourP95,
}: {
  needYou: number;
  sum: { readonly requests: number; readonly failed: number } | null;
  read: boolean;
  usage: boolean;
  viewRead: boolean;
  worstHourP95: number | null;
}): Broken {
  const share = sum?.requests
    ? `${((sum.failed / sum.requests) * 100).toFixed(1)}% of requests failed`
    : null;
  const sub = [
    needYou ? share : null,
    worstHourP95 !== null ? `worst hours p95 ${worstHourP95.toFixed(1)}%` : null,
    share && usage ? "includes proof checks" : null,
  ].filter((line): line is string => line !== null);
  if (needYou)
    return {
      tone: "bad",
      answer: `${needYou} ${needYou === 1 ? "account needs" : "accounts need"} you`,
      sub,
    };
  if (share === null) return { answer: read ? "No requests yet" : "Reading…", sub };
  if (sum!.failed > 0) return { tone: "warn", answer: share, sub };
  return { tone: viewRead ? "ok" : undefined, answer: "Nothing broken", sub };
}
