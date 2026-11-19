import { fileURLToPath } from "node:url";
import { createError, EvlogError } from "evlog";
import {
  causeChain,
  causeLine,
  field,
  members,
  publicError,
  rawChain,
  typeName,
  type PublicCause,
} from "./cause.ts";
import { ChildProcessFailure } from "./child.ts";
import { failureKind, failures } from "./kind.ts";
import { publicGuidance, publicText } from "./redact.ts";

/**
 * A failure as an evlog structured error with what happened, why, how to fix it and the cause
 * chain. Every string in it has passed the rules in `redact.ts`, whoever wrote it: a refusal's
 * reason can quote what a provider said.
 */
export interface FailureReport {
  /** Message, code, why, fix and link, with a cause chain that holds public text only. */
  error: EvlogError;
  /** The same chain, outermost first. */
  causes: PublicCause[];
  /** Named fields of a refusal and its violations, or where an unexpected failure was raised. */
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
const shown = 50;
// Frames are printed from the repository's root: the path above it names a machine and a person.
const root = fileURLToPath(new URL("../../", import.meta.url));
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
// A link is documentation on a site this repository cites, with no query to carry anything.
const linkShape =
  /^https:\/\/(?:developers\.cloudflare\.com|alchemy\.run|github\.com|docs\.github\.com|planetscale\.com|effect\.website|evlog\.dev|nodejs\.org|bun\.sh)(?:\/[A-Za-z0-9/_.~-]*)?(?:#[A-Za-z0-9_.-]*)?$/u;
// `PlanRefused`, or a catalog's `release.BACKUP_MISSING`.
const codeShape = /^(?:[a-z][a-z0-9-]*\.)?[A-Z][A-Za-z0-9_]{1,63}$/u;

/** A refusal is a failure whose author said why: an evlog error, a stated reason, or violations. */
function refused(value: unknown): boolean {
  const violations = field(value, "violations");
  return (
    EvlogError.isEvlogError(value) ||
    text(field(value, "why")) !== undefined ||
    (Array.isArray(violations) && violations.length > 0)
  );
}

function refusal(
  error: unknown,
  subject: unknown,
  environment: NodeJS.ProcessEnv,
): Omit<FailureReport, "tail"> {
  const own = (value: unknown) => publicGuidance(String(value), environment);
  const causes = causeChain(subject, environment).slice(1);
  const details: string[] = [];
  if (subject !== error)
    details.push(`raised inside: ${causeLine(causeChain(error, environment)[0]!)}`);
  for (const key of subjects) {
    const value = field(subject, key);
    if (typeof value === "string" || typeof value === "number")
      details.push(`${key}: ${own(value)}`);
  }
  const detail = field(subject, "detail");
  if (detail !== undefined) {
    let printed = "[not printable]";
    try {
      printed = JSON.stringify(detail) ?? printed;
    } catch {
      // A detail that cannot be printed must not replace the failure it belongs to.
    }
    details.push(`detail: ${own(printed)}`);
  }
  const violations = field(subject, "violations");
  const listed: unknown[] = Array.isArray(violations) ? violations : [];
  for (const violation of listed.slice(0, shown)) {
    const change = field(violation, "change");
    details.push(
      `violation: ${own(
        ["rule", "fqn", "type", "action"]
          .map((key) => text(field(violation, key)))
          .filter(Boolean)
          .join(" ") || "(unnamed)",
      )}`,
      ...(Array.isArray(change)
        ? change.slice(0, shown).map((line) => `  change: ${own(line)}`)
        : []),
      `  why: ${own(text(field(violation, "why")) ?? "(no reason given)")}`,
      `  fix: ${own(text(field(violation, "fix")) ?? "(no fix given)")}`,
    );
  }
  if (listed.length > shown) details.push(`and ${listed.length - shown} more violations`);
  const stated = (key: string) =>
    text(field(subject, key)) ?? (listed.length === 1 ? text(field(listed[0], key)) : undefined);
  const why = stated("why");
  const fix = stated("fix");
  const many = listed.length > 1;
  const link = text(field(subject, "link"));
  const type = typeName(subject);
  // A code is a name. One the rules would change is not, whatever its shape.
  const code = [text(field(subject, "code")), type].find(
    (value) =>
      value !== undefined && value !== "Error" && codeShape.test(value) && own(value) === value,
  );
  const message = text(field(subject, "message"))?.split("\n")[0];
  return {
    error: createError({
      ...(code ? { code } : {}),
      message: many
        ? `${listed.length} violations refused this step`
        : own(message ?? (type === "unknown" ? "The step was refused" : type)),
      ...(many
        ? { why: "Each violation below gives its own reason." }
        : why
          ? { why: own(why) }
          : {}),
      ...(many ? { fix: "Each violation below names its fix." } : fix ? { fix: own(fix) } : {}),
      ...(link && linkShape.test(link) ? { link } : {}),
      ...publicError(causes),
    }),
    causes,
    details,
  };
}

/** Any failure as a structured error. Refusals keep the why and fix their author wrote. */
export function structuredFailure(
  error: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): FailureReport {
  const wrappedBy = rawChain(error);
  const child = wrappedBy.find((value) => value instanceof ChildProcessFailure);
  const tail = child?.report.tail ? { tail: child.report.tail } : {};
  const subject = wrappedBy.find(refused);
  if (subject !== undefined) return { ...refusal(error, subject, environment), ...tail };

  const all = causeChain(error, environment);
  const causes = all.slice(1);
  const details: string[] = [];
  const collected = wrappedBy.map(members).find((list) => list.length > 1);
  if (collected)
    details.push(`failures collected: ${collected.length}; the cause chain follows the first`);
  if (child)
    return {
      error: failures.CHILD_FAILED({
        what: publicGuidance(child.message.split("\n")[0]!, environment),
        ...publicError(causes),
      }),
      causes,
      details,
      ...tail,
    };

  const kind = failureKind(error, environment);
  const top = all[0]!;
  const status = all.find((entry) => entry.status !== undefined)?.status;
  const message = text(field(error, "message"));
  // A code bug's message names the identifier at fault, in quotes; any other message can quote data.
  const bug =
    error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError;
  if (kind === "UNEXPECTED") {
    const stack = field(error, "stack");
    if (typeof stack === "string")
      details.push(
        ...stack
          .split("\n")
          .filter((line) => /^\s+at /u.test(line) && !line.includes("node:"))
          .slice(0, 3)
          .map((line) =>
            publicGuidance(line.trim().replaceAll("file://", "").replaceAll(root, ""), environment),
          ),
      );
  }
  return {
    error: failures[kind]({
      what:
        top.type === "HttpClientError" || top.request
          ? causeLine({ ...top, message: undefined })
          : [
              top.type === "unknown" ? "A failure of an unlisted type" : top.type,
              message && (bug ? publicGuidance : publicText)(message, environment),
            ]
              .filter(Boolean)
              .join(": "),
      why:
        status !== undefined
          ? `The service answered HTTP ${status}.`
          : all.length > 1
            ? `It was caused by ${causeLine(all.at(-1)!).replace(/\.$/u, "")}.`
            : "It carries no cause, so its message is all that is known.",
      ...publicError(causes),
    }),
    causes,
    details,
  };
}
