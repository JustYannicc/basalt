// The load proof's second witness: the mock's own record of when it sent each answer. A call is in
// time only when the driver's measure and the mock's record both say so.
import { sendMarker } from "../emulated-upstream/prompts.ts";
import { sendsPath, type MockSend } from "../emulated-upstream/sends.ts";
import type { Attempt, CallRecord } from "./load-call.ts";
import type { JudgedCall, LoadClass } from "./load-classes.ts";
import { delayBarMs, type LoadKind } from "./load-shape.ts";

export type { MockSend };

export interface Witness {
  /** Every record the mock holds for `run`, or undefined when they could not all be read. */
  read(run: string): Promise<readonly MockSend[] | undefined>;
}

/** What the run's mock records came to. `read` false: none or not all of them could be read. */
export interface WitnessRead {
  readonly read: boolean;
  readonly sends: number;
}

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const optional = (value: unknown) => value === undefined || finite(value);
const isSend = (value: unknown): value is MockSend => {
  if (typeof value !== "object" || value === null) return false;
  const send = value as Record<string, unknown>;
  return (
    typeof send.marker === "string" &&
    typeof send.path === "string" &&
    Number.isSafeInteger(send.status) &&
    finite(send.receivedAt) &&
    finite(send.headersAt) &&
    optional(send.firstContentAt) &&
    optional(send.stallMs) &&
    finite(send.endedAt) &&
    (send.end === "complete" || send.end === "cut")
  );
};
// A run of the mode's longest shape at its highest rate stays far under this many pages.
const maxPages = 50_000;

/**
 * Reads a run's records from the stage Worker's keyed route, page by page. Any page that fails, or
 * holds anything but records, makes the whole read undefined: a partial record never passes.
 */
export function mockWitness({
  origin,
  key,
  fetch: fetcher = fetch,
}: {
  origin: string;
  key: string;
  fetch?: typeof fetch;
}): Witness {
  return {
    async read(run) {
      const sends: MockSend[] = [];
      let after: string | undefined;
      try {
        for (let page = 0; page < maxPages; page++) {
          const url = new URL(sendsPath, origin);
          url.searchParams.set("run", run);
          if (after !== undefined) url.searchParams.set("after", after);
          const response = await fetcher(url, {
            headers: { authorization: `Bearer ${key}` },
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          });
          if (response.status !== 200) {
            await response.body?.cancel();
            return undefined;
          }
          const body = (await response.json()) as { sends?: unknown; next?: unknown };
          if (!Array.isArray(body.sends) || !body.sends.every(isSend)) return undefined;
          sends.push(...body.sends);
          if (body.next === undefined) return sends;
          if (typeof body.next !== "string") return undefined;
          after = body.next;
        }
      } catch {
        return undefined;
      }
      return undefined;
    },
  };
}

/**
 * The mock's view of a call: whether every answer it sent was in time, that it has none, or that it
 * never sent to its end an answer the driver read to its end.
 */
export type MockView = "in_time" | "late" | "missing" | "cut";

const markerOf = (run: string, call: CallRecord, attempt: Pick<Attempt, "attempt">) =>
  sendMarker(run, call.traceId, attempt.attempt);

/**
 * Per send: late when the mock passed on its first content, measured from the driver's own send,
 * or waited between frames, more than the bar past the profile. That wait is a lower bound of the
 * driver's, which reads a frame only after the mock passed it on. A send the driver saw as a 200
 * needs a 200 record, and one that brought the driver content needs a record that carried content:
 * a record cut before any content vouches for no content, but its wait still counts. Any other
 * send gets no say from the mock: its call already fails as failed or retried.
 */
export function mockView(
  run: string,
  call: CallRecord,
  kind: LoadKind,
  sends: ReadonlyMap<string, readonly MockSend[]> | undefined,
): MockView {
  if (!sends) return "missing";
  let view: MockView = "in_time";
  let cut = false;
  for (const attempt of call.attempts) {
    const answers = (sends.get(markerOf(run, call, attempt)) ?? []).filter(
      (send) => send.status === 200,
    );
    const carried = answers.filter((send) => send.firstContentAt !== undefined);
    if (attempt.status === 200 && answers.length === 0) return "missing";
    if (attempt.status === 200 && attempt.firstContentMs !== undefined && carried.length === 0)
      return "missing";
    // Where the mock's record has no end, only the driver would vouch for the end of the answer.
    if (
      attempt.status === 200 &&
      attempt.end === "complete" &&
      !carried.some((send) => send.end === "complete")
    )
      cut = true;
    for (const send of answers) {
      const firstMs = (send.firstContentAt ?? send.endedAt) - attempt.startedAt;
      if (Math.max(firstMs, send.stallMs ?? 0) > kind.ttfbProfileMs + delayBarMs) view = "late";
    }
  }
  return cut ? "cut" : view;
}

/**
 * Both in time: none. Both late: delayed. One late: they disagree. No record: the mock's missing.
 * A record that never ended an answer the driver read to its end: the mock's cut.
 */
export function timeClass(driverLate: boolean, mock: MockView): LoadClass | undefined {
  if (mock === "missing") return "mock_missing";
  if (mock === "cut") return "mock_cut";
  if (driverLate && mock === "late") return "delayed";
  if (driverLate || mock === "late") return "witnesses_disagree";
  return undefined;
}

const witnessClasses: readonly LoadClass[] = ["witnesses_disagree", "mock_missing", "mock_cut"];

/**
 * A judged call with the driver-only `delayed` replaced by both witnesses' outcome. A call in flight
 * at the kill stays an in-flight cut, and also carries a witness class when it has one.
 */
export function witnessed(
  call: JudgedCall,
  kind: LoadKind,
  run: string,
  sends: ReadonlyMap<string, readonly MockSend[]> | undefined,
  order: readonly LoadClass[],
): JudgedCall {
  const driverBar = call.inFlight ? call.inFlight.bar : call.classes;
  const time = timeClass(driverBar.includes("delayed"), mockView(run, call, kind, sends));
  const bar = order.filter(
    (name) => (name !== "delayed" && driverBar.includes(name)) || name === time,
  );
  if (!call.inFlight) return { ...call, classes: bar, pass: bar.length === 0 };
  const extra = bar.filter((name) => witnessClasses.includes(name));
  return {
    ...call,
    classes: bar.length ? ["in_flight_cut", ...extra] : [],
    pass: bar.length === 0,
    inFlight: { ...call.inFlight, bar },
  };
}

/** The run's records by marker. */
export function byMarker(sends: readonly MockSend[]) {
  const map = new Map<string, MockSend[]>();
  for (const send of sends) {
    const list = map.get(send.marker);
    if (list) list.push(send);
    else map.set(send.marker, [send]);
  }
  return map;
}

/** Records of the run whose marker names no send the driver recorded, the kill's resends included. */
export function driverMissing(
  run: string,
  calls: readonly JudgedCall[],
  sends: ReadonlyMap<string, readonly MockSend[]>,
) {
  const known = new Set<string>();
  for (const call of calls) {
    for (const attempt of call.attempts) known.add(markerOf(run, call, attempt));
    if (call.inFlight?.resend) known.add(markerOf(run, call, call.inFlight.resend));
  }
  let missing = 0;
  for (const marker of sends.keys()) if (!known.has(marker)) missing += 1;
  return missing;
}
