import { createError, defineErrorCatalog, EvlogError } from "evlog";
import {
  causeChain,
  causeLine,
  field,
  interrupted,
  neverSent,
  typeName,
  wrapped,
  type PublicCause,
} from "./cause.ts";
import { ChildProcessFailure } from "./child.ts";
import { publicGuidance, publicText, redactCredentials } from "./redact.ts";

/**
 * What a failure is: an evlog structured error with what happened, why, how to fix it and the cause
 * chain. Every string in it has passed the rules in `redact.ts`, whoever wrote it: a refusal's
 * reason can quote what a provider said.
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
    fix: "The request never left, so nothing changed at the service. Rerun; if it repeats, check the service's status.",
  },
  OUTCOME_UNKNOWN: {
    message: what,
    fix: "The request may have reached the service before the connection failed. A read can be rerun. Before rerunning a write, check whether it took effect.",
  },
  SERVICE_BUSY: {
    message: what,
    fix: "The service answered with a temporary failure. Wait and rerun. Before rerunning a write, check whether it took effect.",
  },
  REQUEST_REFUSED: {
    message: what,
    fix: "A rerun gets the same answer. Fix the request, its credentials or what it names, as the status and cause chain say.",
  },
  REQUEST_INVALID: {
    message: what,
    fix: "The request failed before it was sent and will fail the same way on a rerun. Fix the call named in the cause chain.",
  },
  UNEXPECTED: {
    message: what,
    fix: "This failure has no written fix yet. Follow the cause chain to the step that raised it.",
  },
});

export interface FailureReport {
  /** Message, code, why, fix and link, with a cause chain that holds public text only. */
  error: EvlogError;
  /** The same chain, outermost first. */
  causes: PublicCause[];
  /** Named fields of a refusal and its violations, one line each. */
  details: string[];
  /** The last output lines of a failed command, already public. */
  tail?: string;
}

const subjects = [
  "resource",
  "check",
  "rule",
  "script",
  "reason",
  "route",
  "method",
  "path",
  "field",
  "value",
];
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
// A documentation link: no query, nothing that a redaction rule would change.
const linkShape = /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9/_.~-]*)?(?:#[A-Za-z0-9_.-]*)?$/u;

/** Rebuilt from public causes, so nothing that prints the error can reach the original text. */
function publicError(causes: PublicCause[]): Error | undefined {
  let inner: Error | undefined;
  for (const cause of causes.toReversed()) {
    inner = new Error(causeLine(cause), inner ? { cause: inner } : {});
    inner.name = cause.type;
    delete inner.stack;
  }
  return inner;
}

function find<A>(error: unknown, match: (value: unknown) => A | undefined): A | undefined {
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current); current = wrapped(current)) {
    seen.add(current);
    const found = match(current);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Any failure as a structured error. Refusals keep the why and fix their author wrote. */
export function structuredFailure(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): FailureReport {
  const own = (value: unknown) => publicGuidance(String(value), environment);
  const all = causeChain(error, environment);
  const causes = all.slice(1);
  const cause = publicError(causes);
  const options = cause ? { cause } : {};
  const child = find(error, (value) => (value instanceof ChildProcessFailure ? value : undefined));
  const tail = child?.report.tail ? { tail: child.report.tail } : {};
  const type = typeName(error);

  const details: string[] = [];
  const members = field(error, "errors");
  if (Array.isArray(members) && members.length > 1)
    details.push(`failures collected: ${members.length}; the cause chain follows the first`);
  const violations = field(error, "violations");
  const listed: unknown[] = Array.isArray(violations) ? violations.slice(0, 50) : [];
  const stated = (key: string) =>
    text(field(error, key)) ?? (listed.length === 1 ? text(field(listed[0], key)) : undefined);
  const why = stated("why");
  const fix = stated("fix");
  if (EvlogError.isEvlogError(error) || (why && fix) || listed.length > 0) {
    for (const key of subjects) {
      const value = field(error, key);
      if (typeof value === "string" || typeof value === "number")
        details.push(`${key}: ${own(value)}`);
    }
    const detail = field(error, "detail");
    if (detail !== undefined) {
      let printed = "[not printable]";
      try {
        printed = JSON.stringify(detail) ?? printed;
      } catch {
        // A detail that cannot be printed must not replace the failure it belongs to.
      }
      details.push(`detail: ${own(printed)}`);
    }
    for (const violation of listed) {
      const change = field(violation, "change");
      details.push(
        `violation: ${own(
          ["rule", "fqn", "type", "action"]
            .map((key) => text(field(violation, key)))
            .filter(Boolean)
            .join(" ") || "(unnamed)",
        )}`,
        ...(Array.isArray(change)
          ? change.slice(0, 50).map((line) => `  change: ${own(line)}`)
          : []),
        `  why: ${own(text(field(violation, "why")) ?? "(no reason given)")}`,
        `  fix: ${own(text(field(violation, "fix")) ?? "(no fix given)")}`,
      );
    }
    const many = listed.length > 1;
    const link = text(field(error, "link"));
    const code = text(field(error, "code")) ?? (type === "unknown" ? undefined : type);
    const message = text(field(error, "message"))?.split("\n")[0];
    return {
      error: createError({
        ...(code && /^[A-Za-z][\w./-]{0,63}$/u.test(code) ? { code } : {}),
        message: many
          ? `${listed.length} violations refused this step`
          : own(message ?? why ?? "The step was refused"),
        ...(many
          ? { why: "Each violation below gives its own reason." }
          : why
            ? { why: own(why) }
            : {}),
        ...(many ? { fix: "Each violation below names its fix." } : fix ? { fix: own(fix) } : {}),
        ...(link && linkShape.test(link) && redactCredentials(link, environment) === link
          ? { link }
          : {}),
        ...options,
      }),
      causes,
      details,
      ...tail,
    };
  }

  if (child)
    return {
      error: failures.CHILD_FAILED({ what: child.message.split("\n")[0]!, ...options }),
      causes,
      details,
      ...tail,
    };
  const top = all[0]!;
  const inner = all.at(-1)!;
  const message = text(field(error, "message"));
  const status = all.find((entry) => entry.status !== undefined)?.status;
  const coded = (set: Set<string>) =>
    all.some((entry) => entry.code !== undefined && set.has(entry.code));
  const request = all.some((entry) => entry.request || entry.type === "HttpClientError");
  const kind =
    status !== undefined
      ? status === 408 || status === 425 || status === 429 || status >= 500
        ? failures.SERVICE_BUSY
        : failures.REQUEST_REFUSED
      : coded(neverSent)
        ? failures.UNREACHABLE
        : coded(interrupted) || all.some((entry) => /Timeout|Abort/u.test(entry.type))
          ? failures.OUTCOME_UNKNOWN
          : request
            ? failures.REQUEST_INVALID
            : failures.UNEXPECTED;
  return {
    error: kind({
      what:
        top.type === "HttpClientError" || top.request
          ? causeLine({ ...top, message: undefined })
          : [
              top.type === "unknown" ? "A failure of an unlisted type" : top.type,
              top.message ?? (message && publicText(message, environment)),
            ]
              .filter(Boolean)
              .join(": "),
      why:
        status !== undefined
          ? `The service answered HTTP ${status}.`
          : all.length > 1
            ? `It was caused by ${causeLine(inner)}.`
            : "It carries no cause, so its message is all that is known.",
      ...options,
    }),
    causes,
    details,
  };
}
