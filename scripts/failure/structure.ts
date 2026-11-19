import { fileURLToPath } from "node:url";
import { createError, EvlogError } from "evlog";
import {
  causeChain,
  causeLine,
  field,
  members,
  publicError,
  reach,
  typeName,
  type PublicCause,
} from "./cause.ts";
import { ChildProcessFailure } from "./child.ts";
import { failureKind, failures } from "./kind.ts";
import { publicGuidance, publicTail, publicText, redactCredentials } from "./redact.ts";
import { stackCommand } from "./stack-command.ts";

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
  /** A refusal's evidence and violations, collected failures, or where a failure was raised. */
  details: string[];
  /** The last output lines of every failed command, already public. */
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
  "detail",
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

/** A refusal's evidence as its author gave it: text as written, anything else as JSON. */
function printed(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Evidence that cannot be printed must not replace the failure it belongs to.
    return "[not printable]";
  }
}

/** What a failure says of itself: its type and its message, as text nobody here wrote. */
function said(error: unknown, environment: NodeJS.ProcessEnv): string {
  // Alchemy's own message for a command it ran ends in that command's whole standard error.
  const ran = stackCommand(error, environment);
  if (ran) return ran.what;
  const type = typeName(error);
  const message = text(typeof error === "string" ? error : field(error, "message"));
  return [
    type === "unknown" ? "A failure of an unlisted type" : type,
    message && publicText(message, environment),
  ]
    .filter(Boolean)
    .join(": ");
}

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
  const own = (value: unknown) => publicGuidance(printed(value), environment);
  const causes = causeChain(subject, environment).slice(1);
  const details: string[] = [];
  if (subject !== error) details.push(`raised inside: ${said(error, environment)}`);
  for (const key of subjects) {
    const value = field(subject, key);
    if (value !== undefined && value !== null && typeof value !== "function")
      details.push(`${key}: ${own(value)}`);
  }
  const violations = field(subject, "violations");
  const listed: unknown[] = Array.isArray(violations) ? violations : [];
  for (const violation of listed.slice(0, shown)) {
    const change = field(violation, "change");
    const name = ["rule", "fqn", "type", "action"]
      .map((key) => text(field(violation, key)))
      .filter(Boolean)
      .join(" ");
    details.push(
      `violation: ${own(name || "(unnamed)")}`,
      ...(Array.isArray(change)
        ? change.slice(0, shown).map((line) => `  change: ${own(line)}`)
        : []),
      `  why: ${own(text(field(violation, "why")) ?? "(no reason given)")}`,
      `  fix: ${own(text(field(violation, "fix")) ?? "(no fix given)")}`,
    );
  }
  if (listed.length > shown) details.push(`and ${listed.length - shown} more violations`);

  const many = listed.length > 1;
  const stated = (key: string, all: string) => {
    if (many) return all;
    const one = text(field(subject, key)) ?? text(field(listed[0], key));
    return one && own(one);
  };
  const why = stated("why", "Each violation below gives its own reason.");
  const fix = stated("fix", "Each violation below names its fix.");
  const type = typeName(subject);
  // A code is a name. One the rules would change is not, whatever its shape.
  const code = [text(field(subject, "code")), type].find(
    (value) =>
      value !== undefined && value !== "Error" && codeShape.test(value) && own(value) === value,
  );
  // A token can sit in a path, so each part of the link has to pass the credential rules.
  const link = text(field(subject, "link"));
  const linked =
    link !== undefined &&
    linkShape.test(link) &&
    link.split(/[/#]/u).every((part) => redactCredentials(part, environment) === part);
  const message = text(field(subject, "message"))?.split("\n")[0];
  return {
    error: createError({
      ...(code ? { code } : {}),
      message: many
        ? `${listed.length} violations refused this step`
        : own(message ?? (type === "unknown" ? "The step was refused" : type)),
      ...(why ? { why } : {}),
      ...(fix ? { fix } : {}),
      ...(linked ? { link } : {}),
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
  const all = reach(error);
  // Every command that failed: one run here, with the end of its output, or one Alchemy ran, with
  // what Alchemy's error keeps of it.
  const commands = all.flatMap((value): { what: string; tail: string; why?: string }[] => {
    if (value instanceof ChildProcessFailure)
      return [
        {
          what: publicGuidance(value.message.split("\n")[0]!, environment),
          // Made public again here: a report built by a caller is not known to be.
          tail: publicTail(value.report.tail, environment),
        },
      ];
    const ran = stackCommand(value, environment);
    return ran ? [ran] : [];
  });
  const subject = all.find(refused);
  // A command the report is not named after is named above its own output.
  const headed = commands.length > 1 || subject !== undefined;
  const output = commands
    .flatMap(({ what, why, tail }) => [
      ...(headed ? [`--- ${what}${why ? `: ${why}` : ""}`] : []),
      tail,
    ])
    .filter(Boolean)
    .join("\n");
  const tail = output ? { tail: output } : {};
  if (subject !== undefined) return { ...refusal(error, subject, environment), ...tail };

  const chain = causeChain(error, environment);
  const causes = chain.slice(1);
  const details: string[] = [];
  const collected = all.map(members).find((list) => list.length > 1);
  if (collected)
    details.push(
      `failures collected: ${collected.length}; the cause chain follows the first`,
      ...collected
        .slice(0, 8)
        .map((member, index) => `failure ${index + 1}: ${said(member, environment)}`),
    );
  const [first] = commands;
  if (first) {
    const { what, why } = first;
    return {
      error: why
        ? failures.STACK_COMMAND_FAILED({ what, why, ...publicError(causes) })
        : failures.CHILD_FAILED({ what, ...publicError(causes) }),
      causes,
      details,
      ...tail,
    };
  }

  const kind = failureKind(error, environment);
  const top = chain[0] ?? { type: "unknown" };
  const status = chain.find((entry) => entry.status !== undefined)?.status;
  const stack = kind === "UNEXPECTED" ? field(error, "stack") : undefined;
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
  let why = "It carries no cause, so its message is all that is known.";
  if (status !== undefined) why = `The service answered HTTP ${status}.`;
  else if (chain.length > 1)
    why = `It was caused by ${causeLine(chain.at(-1)!).replace(/[.!?]$/u, "")}.`;
  return {
    error: failures[kind]({
      what:
        top.type === "HttpClientError" || top.request
          ? causeLine({ ...top, message: undefined })
          : said(error, environment),
      why,
      ...publicError(causes),
    }),
    causes,
    details,
  };
}
