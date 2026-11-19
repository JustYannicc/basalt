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
  // A command Alchemy ran: its error keeps the exit code and the standard error, nothing else.
  STACK_COMMAND_FAILED: {
    message: what,
    fix: "Fix what the standard error lines below name. If there are none, or they do not explain the failure, run the command alone to see everything it prints. Then rerun this step.",
  },
  UNREACHABLE: {
    message: what,
    fix: "This attempt could not open a connection, so it sent nothing. Rerun it. If the request was redirected or retried before this attempt, check first whether a write took effect.",
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
    fix: "The service did not accept the request. Before rerunning, fix the request, its credentials or the state it conflicts with, as the status and cause chain say.",
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
type Kind = Exclude<
  keyof typeof failures,
  "_prefix" | "_codes" | "CHILD_FAILED" | "STACK_COMMAND_FAILED"
>;

// What fetch says when it refuses its own arguments, under Node and under Bun.
const refusedArguments =
  /^(?:Request with GET\/HEAD method cannot have body|Request cannot be constructed|RequestInit: |Headers\.\w+: |Header '[^']*' has invalid value)|is not a valid HTTP method\.$/u;

/** What a rerun of one failed request would do, or undefined when it was not a request. */
function requestKind(error: unknown, environment: NodeJS.ProcessEnv): Kind | undefined {
  const all = causeChain(error, environment);
  const status = all.find((entry) => entry.status !== undefined)?.status;
  if (status !== undefined) {
    if (status === 408 || status === 425 || status === 429 || status >= 500) return "SERVICE_BUSY";
    // A redirect that was not followed changed nothing: the request went to the wrong place.
    return status >= 300 ? "REQUEST_REFUSED" : "ANSWER_UNREADABLE";
  }
  const coded = (set: Set<string>) =>
    all.some((entry) => entry.code !== undefined && set.has(entry.code));
  if (coded(neverSent)) return "UNREACHABLE";
  if (coded(interrupted)) return "OUTCOME_UNKNOWN";
  if (!all.some((entry) => entry.request || entry.type === "HttpClientError")) return undefined;
  // Nothing was sent when the request could not be built or fetch refused its arguments. Any
  // other failure of a request, known or not, leaves the outcome open.
  const reason = all.find((entry) => entry.reason !== undefined)?.reason;
  const leaf = rawChain(error).at(-1);
  const message = field(leaf, "message");
  const argument =
    leaf instanceof TypeError && typeof message === "string" && refusedArguments.test(message);
  return reason === "EncodeError" || reason === "InvalidUrlError" || coded(badArguments) || argument
    ? "REQUEST_INVALID"
    : "OUTCOME_UNKNOWN";
}

// From the kind a rerun could hurt most to the one it cannot hurt.
const leastSafeFirst: Kind[] = [
  "ANSWER_UNREADABLE",
  "OUTCOME_UNKNOWN",
  "SERVICE_BUSY",
  "REQUEST_REFUSED",
  "REQUEST_INVALID",
];

function kindOf(error: unknown, environment: NodeJS.ProcessEnv, depth: number): Kind | undefined {
  const group = rawChain(error)
    .map(members)
    .find((list) => list.length > 1);
  if (!group) return requestKind(error, environment);
  // Past this depth nothing is claimed about a rerun.
  if (depth > 4) return undefined;
  const kinds = group.map((member) => kindOf(member, environment, depth + 1));
  return (
    leastSafeFirst.find((kind) => kinds.includes(kind)) ??
    (kinds.every((kind) => kind === "UNREACHABLE") ? "UNREACHABLE" : undefined)
  );
}

/** Collected failures are only as safe to rerun as the least safe of them, however they nest. */
export const failureKind = (error: unknown, environment: NodeJS.ProcessEnv): Kind =>
  kindOf(error, environment, 0) ?? "UNEXPECTED";
