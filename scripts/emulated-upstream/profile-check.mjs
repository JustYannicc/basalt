// The check's proof of the two account profiles: a clean answer through a; through b its latency,
// then its 429 with Retry-After; and a clean answer through a while b refuses every call.
import { chaosFrom, profileControlPath, RETRY_AFTER_SECONDS } from "./gateway.ts";
import { publicMessage } from "./public-error.mjs";
import { paths, requestBody } from "./shapes.mjs";

/** Profile b's latency while the check calls through it; well inside every call's timeout. */
export const SLOW_MS = 2_000;
const steps = ["read", "slow", "limited", "restore"];
const profileCalls = 5;
/** A call that must not carry b's latency ends well before it. */
const unslowed = { atMostMs: SLOW_MS / 2, late: "carried profile b's latency" };

/**
 * Sets profile b's faults for the check's own calls, then puts back what it found, even after a
 * failed call. A load run sending through b at the same moment sees the check's faults meanwhile.
 * `model(shape, options)` is the stage's judged model call; `call` its raw one.
 */
export async function profileCheck({ base, key, call, model }) {
  const control = [];
  const calls = [];
  let limited;
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  const set = async (step, init) => {
    const answer = await call(
      base,
      `profile b ${step}`,
      profileControlPath,
      { ...init, headers },
      (response) => (response.ok ? response.json() : response.body?.cancel()),
    );
    control.push({ step, status: answer.status });
    return answer;
  };
  let found;
  try {
    const read = await set("read", { method: "GET" });
    found = chaosFrom({
      rateLimitRate: read.body?.rateLimitRate,
      latencyMs: read.body?.latencyMs,
    });
    if (read.status !== 200 || !found)
      return { control, calls, failure: "profile b's faults could not be read" };
    try {
      const slow = { rateLimitRate: 0, latencyMs: SLOW_MS };
      await set("slow", { method: "PUT", body: JSON.stringify(slow) });
      calls.push(
        // While b is set slow, a and unprefixed calls must not carry its latency. They run before
        // b's own call, so b's latency can't overlap their measured time on any clock.
        ...(await Promise.all([
          model("messages", { kind: "via a", via: "/a", ...unslowed }),
          model("messages", { kind: "unprefixed beside b's latency", ...unslowed }),
        ])),
        await model("messages", {
          kind: "via b, slow",
          via: "/b",
          atLeastMs: SLOW_MS,
          early: "answered before profile b's latency",
        }),
      );
      await set("limited", {
        method: "PUT",
        body: JSON.stringify({ rateLimitRate: 1, latencyMs: 0 }),
      });
      const [refused, ...beside] = await Promise.all([
        limitedCall(base, headers, call),
        model("messages", { kind: "via a beside b's 429", via: "/a" }),
        model("messages", { kind: "unprefixed beside b's 429" }),
      ]);
      limited = refused;
      calls.push(...beside);
    } finally {
      await set("restore", { method: "PUT", body: JSON.stringify(found) });
    }
  } catch (error) {
    return { control, calls, limited, found, failure: publicMessage(error) };
  }
  return { control, calls, limited, found };
}

/** A short Messages stream through b while b's 429 share is 1: its status and retry time only. */
async function limitedCall(base, headers, call) {
  try {
    const answer = await call(
      base,
      "messages via b, limited",
      `/b${paths.messages}`,
      {
        method: "POST",
        headers: { ...headers, "anthropic-version": "2023-06-01", accept: "text/event-stream" },
        body: JSON.stringify(requestBody("messages", false)),
      },
      async (response) => {
        const retryAfter = response.headers.get("retry-after") ?? undefined;
        const otherTimes = [...response.headers.keys()].some((name) =>
          name.startsWith("x-ratelimit-"),
        );
        if (response.status !== 429) {
          await response.body?.cancel();
          return { retryAfter, otherTimes, chaos: false };
        }
        // aimock's chaos 429 names itself; a 429 from anything in front of it would not.
        const body = await response.json().catch(() => undefined);
        return { retryAfter, otherTimes, chaos: body?.error?.code === "chaos_ratelimit" };
      },
    );
    return { status: answer.status, ...answer.body };
  } catch (error) {
    return { reason: publicMessage(error) };
  }
}

/** Every reason the profile proof fails; none means it passes. */
export function profileFailures(profiles) {
  if (!profiles) return ["the profile check did not run"];
  const { control = [], calls = [], limited, failure } = profiles;
  const retry = String(RETRY_AFTER_SECONDS);
  return [
    ...(failure ? [`profile check: ${failure}`] : []),
    ...steps
      .map((step) => [step, control.find((row) => row.step === step)?.status])
      .filter(([, status]) => status !== 200)
      .map(([step, status]) => `profile b ${step}: HTTP ${status ?? "-"}`),
    ...(calls.length !== profileCalls
      ? [`${calls.length} of ${profileCalls} profile calls ran`]
      : []),
    ...calls.filter((row) => !row.pass).map((row) => `${row.shape} ${row.kind} ${row.reason}`),
    ...(limited?.status !== 429
      ? [
          `messages via b at a 429 share of 1: ${limited?.reason ?? `HTTP ${limited?.status ?? "-"}`}`,
        ]
      : [
          ...(limited.retryAfter !== retry
            ? [`profile b's 429 carried Retry-After ${limited.retryAfter ?? "none"}, not ${retry}`]
            : []),
          ...(limited.otherTimes ? ["profile b's 429 carried aimock's own reset headers"] : []),
          ...(limited.chaos ? [] : ["profile b's 429 was not aimock's chaos answer"]),
        ]),
  ];
}

/** The summary's lines for the profile proof. */
export function profileSummary(profiles) {
  const { control = [], calls = [], limited, found } = profiles ?? {};
  return [
    `- profile b found at: ${found ? `429 share ${found.rateLimitRate}, latency ${found.latencyMs} ms` : "unread"}`,
    `- profile b control: ${control.map((row) => `${row.step} HTTP ${row.status}`).join(", ") || "none"}`,
    ...calls.map(
      (row) =>
        `- ${row.shape} ${row.kind}: HTTP ${row.status ?? "-"}, ${row.ms ?? "-"} ms, ${row.pass ? "passes" : `fails: ${row.reason}`}`,
    ),
    `- messages via b at a 429 share of 1: HTTP ${limited?.status ?? "-"}, Retry-After ${limited?.retryAfter ?? "none"}${limited?.chaos ? ", aimock's chaos answer" : ""}`,
  ];
}
