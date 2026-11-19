import { defineErrorCatalog } from "evlog";
import {
  badArguments,
  causeChain,
  field,
  interrupted,
  members,
  neverSent,
  rawChain,
} from "./cause.ts";

/**
 * What kind of failure it is, which for a request means what a rerun would do. The fix each kind
 * names is the advice a person acts on, so a kind is chosen only on evidence for it.
 */
const what = ({ what }: { what: string }) => what;
export const failures = defineErrorCatalog("release", {
  CHILD_FAILED: {
    message: what,
    why: "A command this step ran did not succeed. Its last output lines are below.",
    fix: "Fix what the output names and rerun this step. If the output is empty, run the command alone to see it fail.",
  },
  UNREACHABLE: {
    message: what,
    fix: "This request never left, so it changed nothing at the service. Rerun; if it repeats, check the service's status.",
  },
  OUTCOME_UNKNOWN: {
    message: what,
    fix: "The request may have reached the service. A read can be rerun. Before rerunning a write, check whether it took effect.",
  },
  SERVICE_BUSY: {
    message: what,
    fix: "The service answered with a temporary failure. Wait and rerun. Before rerunning a write, check whether it took effect.",
  },
  REQUEST_REFUSED: {
    message: what,
    fix: "The service refused the request. Before rerunning, fix the request, its credentials or the state it conflicts with, as the status and cause chain say.",
  },
  ANSWER_UNREADABLE: {
    message: what,
    fix: "The service answered without an error status, so a write has most likely taken effect. Check that before rerunning, and fix how the answer is read, as the cause chain says.",
  },
  REQUEST_INVALID: {
    message: what,
    fix: "The request was refused before it was sent and will be refused again on a rerun. Fix the call named in the cause chain.",
  },
  UNEXPECTED: {
    message: what,
    fix: "This failure has no written fix yet. Start at the frames and the cause chain below.",
  },
});
type Kind = Exclude<keyof typeof failures, "_prefix" | "_codes" | "CHILD_FAILED">;

/** What a rerun of one failed request would do, or undefined when it was not a request. */
function requestKind(error: unknown, environment: NodeJS.ProcessEnv): Kind | undefined {
  const all = causeChain(error, environment);
  const status = all.find((entry) => entry.status !== undefined)?.status;
  if (status !== undefined)
    return status === 408 || status === 425 || status === 429 || status >= 500
      ? "SERVICE_BUSY"
      : status >= 400
        ? "REQUEST_REFUSED"
        : "ANSWER_UNREADABLE";
  const coded = (set: Set<string>) =>
    all.some((entry) => entry.code !== undefined && set.has(entry.code));
  if (coded(neverSent)) return "UNREACHABLE";
  if (coded(interrupted)) return "OUTCOME_UNKNOWN";
  if (!all.some((entry) => entry.request || entry.type === "HttpClientError")) return undefined;
  // Nothing was sent when the request could not be built or fetch refused its arguments. fetch
  // raises that as a TypeError of its own; a network failure is "fetch failed" around a cause.
  const reason = all.find((entry) => entry.reason !== undefined)?.reason;
  const leaf = rawChain(error).at(-1);
  const argument =
    leaf instanceof TypeError &&
    field(leaf, "code") === undefined &&
    field(leaf, "message") !== "fetch failed";
  return reason === "EncodeError" || reason === "InvalidUrlError" || coded(badArguments) || argument
    ? "REQUEST_INVALID"
    : "OUTCOME_UNKNOWN";
}

/** A collected failure is only as safe to rerun as its least safe member. */
export function failureKind(error: unknown, environment: NodeJS.ProcessEnv): Kind {
  const group = rawChain(error)
    .map(members)
    .find((list) => list.length > 1);
  if (!group) return requestKind(error, environment) ?? "UNEXPECTED";
  const kinds = group.map((member) => requestKind(member, environment));
  if (kinds.every((kind) => kind === "UNREACHABLE")) return "UNREACHABLE";
  return kinds.find((kind) => kind !== undefined && kind !== "UNREACHABLE") ?? "UNEXPECTED";
}
