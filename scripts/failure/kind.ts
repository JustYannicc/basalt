import { defineErrorCatalog } from "evlog";
import { badArguments, closedCause, interrupted, neverSent } from "./cause.ts";
import { chainCut, field, heldInPart, isA, members, rawChain, unreadable } from "./graph.ts";

/**
 * What kind of failure it is, which for a request means what a rerun would do. The fix each kind
 * names is the advice a person acts on, so a kind is chosen only on evidence for it.
 */
const what = ({ what }: { what: string }) => what;
export const failures = defineErrorCatalog("release", {
  // A command run here, and one Alchemy ran for a resource. How each ended decides its reason and
  // its fix: see `command.ts`.
  CHILD_FAILED: { message: what },
  STACK_COMMAND_FAILED: { message: what },
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
function requestKind(chain: unknown[]): Kind | undefined {
  const all = chain.map((entry) => {
    try {
      return closedCause(entry);
    } catch {
      return { type: "unknown" };
    }
  });
  const status = all.find((entry) => entry.status !== undefined)?.status;
  if (status !== undefined) {
    // 501 and 505 say the service will never do this, which waiting does not change.
    const later = status >= 500 && status !== 501 && status !== 505;
    if (status === 408 || status === 425 || status === 429 || later) return "SERVICE_BUSY";
    // Only a redirect that keeps the method says the request was not acted on. Any other answer
    // below 400, a 303 after a write among them, can follow a write that took effect.
    return status >= 400 || status === 307 || status === 308
      ? "REQUEST_REFUSED"
      : "ANSWER_UNREADABLE";
  }
  const coded = (set: Set<string>) =>
    all.some((entry) => entry.code !== undefined && set.has(entry.code));
  // An earlier attempt in the same chain may have been sent, whatever stopped the last one.
  if (coded(interrupted)) return "OUTCOME_UNKNOWN";
  if (coded(neverSent)) return "UNREACHABLE";
  if (!all.some((entry) => entry.request || entry.type === "HttpClientError")) return undefined;
  // Nothing was sent when the request could not be built or fetch refused its arguments. Any
  // other failure of a request, known or not, leaves the outcome open.
  const reason = all.find((entry) => entry.reason !== undefined)?.reason;
  const leaf = chain.at(-1);
  const message = field(leaf, "message");
  const argument =
    isA(leaf, TypeError) && typeof message === "string" && refusedArguments.test(message);
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

/** Failures that were not all read, so nothing is claimed about a rerun. */
const unread = "unread";
type Read = Kind | undefined | typeof unread;
/** The kinds whose advice already says a write may have landed: nothing unread can be worse. */
export const mayHaveLanded = new Set<Read>([
  "ANSWER_UNREADABLE",
  "OUTCOME_UNKNOWN",
  "SERVICE_BUSY",
]);
// Bounds for the stack and the time a report takes, far past any real failure.
const deepest = 32;
const readable = 4000;

function kindOf(
  error: unknown,
  depth: number,
  // A failure held by many collections is read once, however often it is reached.
  state: { known: Map<unknown, Read>; left: number },
): Read {
  if (state.known.has(error)) return state.known.get(error);
  if (--state.left < 0) return unread;
  const chain = rawChain(error);
  const holder = chain.find((entry) => members(entry).length > 1);
  let kind: Read;
  if (holder === undefined) {
    kind = requestKind(chain);
    // Past the levels that are read, or behind one that cannot be, a write may still have landed.
    if ((chainCut(error) || chain.some(unreadable)) && !mayHaveLanded.has(kind)) kind = unread;
  } else if (depth >= deepest) kind = unread;
  else {
    // A collection that holds itself adds nothing new while it is being read.
    state.known.set(error, undefined);
    const kinds = members(holder).map((member) => kindOf(member, depth + 1, state));
    const found =
      leastSafeFirst.find((unsafe) => kinds.includes(unsafe)) ??
      (kinds.every((member) => member === "UNREACHABLE") ? "UNREACHABLE" : undefined);
    // Members left unread, past the limit or too deep, may hold a write that landed: only a kind
    // whose advice already allows for that can stand.
    const partial = heldInPart(holder) || kinds.includes(unread);
    kind = partial && !mayHaveLanded.has(found) ? unread : found;
  }
  state.known.set(error, kind);
  return kind;
}

/** Collected failures are only as safe to rerun as the least safe of them, however they nest. */
export function failureKind(error: unknown): Kind {
  const kind = kindOf(error, 0, { known: new Map(), left: readable });
  return kind === unread || kind === undefined ? "UNEXPECTED" : kind;
}
